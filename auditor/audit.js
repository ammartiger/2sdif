"use strict";
/**
 * Omission auditor (Algorithm 3). Compares the witness log with ProofCommitted events.
 *   node auditor/audit.js --delta 30 [--from-block 0] [--watch --period 10 --out results/audit_watch.csv]
 * Env: NETWORK, WITNESS_URL, AUDITOR_KEY (sent as x-auditor-key and x-functions-key).
 *
 * For every witness log entry e (attested at time tW) the auditor reports:
 *   INVALID   the entry's attestation does not verify under the registered witness key, or its rid is
 *             not H(did, seq)  -> the log itself is not trustworthy
 *   OMITTED   no commitment, and tW + delta has passed (clock skew bound skewSec added)
 *   LATE      committed, but in a block whose timestamp exceeds tW + delta + skew
 *   MISMATCH  committed with a different digest (impossible unless the witness key was misused)
 * and, per device, GAPS in the sequence numbers between the lowest and highest seen, which reveal
 * deposits that never reached the witness (for example, channel 2 suppressed).
 * Committed proofs with no log entry are reported as UNATTESTED.
 */
const { ethers } = require("ethers");
const P = require("../shared/protocol");

/** Pure audit logic, used by the CLI and by the tests. */
function auditEntries({ entries, committed, nowSec, deltaSec, skewSec = 0, witness, chainId, contract }) {
  const omitted = [], late = [], inconsistent = [], invalid = [];
  const logged = new Set();
  const seqs = new Map(); // did -> [seq]
  for (const e of entries) {
    if (witness) {
      let ok = false;
      try {
        ok = P.recordId(e.did, e.seq) === e.rid.toLowerCase() &&
          P.recoverAttestationSigner({ chainId, contract, did: e.did, seq: e.seq, h: e.h, tW: e.tW }, e.sig).toLowerCase() === witness.toLowerCase();
      } catch {
        ok = false;
      }
      if (!ok) { invalid.push(e.rid); continue; }
    }
    logged.add(e.rid);
    if (!seqs.has(e.did)) seqs.set(e.did, []);
    seqs.get(e.did).push(BigInt(e.seq));
    const c = committed.get(e.rid);
    const deadline = Number(e.tW) + deltaSec + skewSec;
    if (!c) {
      if (nowSec > deadline) omitted.push(e.rid);
    } else {
      if (c.digest.toLowerCase() !== e.h.toLowerCase()) inconsistent.push(e.rid);
      if (c.time !== undefined && c.time > deadline) late.push({ rid: e.rid, delaySec: c.time - Number(e.tW) });
    }
  }
  const gaps = [];
  for (const [did, list] of seqs) {
    list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < list.length; i++) {
      if (list[i] - list[i - 1] > 1n) gaps.push({ did, from: (list[i - 1] + 1n).toString(), to: (list[i] - 1n).toString() });
    }
  }
  const unattested = [...committed.keys()].filter((rid) => !logged.has(rid));
  return { omitted, late, inconsistent, invalid, gaps, unattested };
}

/** rid -> { digest, block, time } from ProofCommitted events (block timestamps fetched once per block). */
async function committedProofs(contract, fromBlock = 0) {
  const events = await contract.queryFilter(contract.filters.ProofCommitted(), fromBlock);
  const times = new Map();
  const m = new Map();
  for (const ev of events) {
    if (!times.has(ev.blockNumber)) times.set(ev.blockNumber, (await ev.getBlock()).timestamp);
    m.set(ev.args.rid.toLowerCase(), { digest: ev.args.digest, block: ev.blockNumber, time: times.get(ev.blockNumber) });
  }
  return m;
}

async function fetchWitnessLog(witnessUrl, auditorKey, sinceSec = 0) {
  const r = await fetch(`${witnessUrl}/log?since=${sinceSec}`, { headers: { "x-auditor-key": auditorKey, "x-functions-key": auditorKey } });
  if (r.status !== 200) throw new Error(`witness log returned ${r.status}`);
  return (await r.json()).entries;
}

async function main() {
  const fs = require("fs");
  const path = require("path");
  const cfg = require("../shared/config");
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const net = cfg.network();
  const dep = cfg.deployment(net);
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl(net));
  const artifact = require("../artifacts/contracts/TwoSDIFRegistry.sol/TwoSDIFRegistry.json");
  const contract = new ethers.Contract(dep.address, artifact.abi, provider);
  const witness = await contract.witness();
  const witnessUrl = (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, "");
  const deltaSec = Number(arg("delta", 30)), skewSec = Number(arg("skew", 5));
  const since = Number(arg("since", 0));
  const run = async () => {
    const entries = await fetchWitnessLog(witnessUrl, process.env.AUDITOR_KEY, since);
    const committed = await committedProofs(contract, Number(arg("from-block", dep.block || 0)));
    const nowSec = Math.floor(Date.now() / 1000);
    return { nowSec, logEntries: entries.length, committed: committed.size, ...auditEntries({ entries, committed, nowSec, deltaSec, skewSec, witness, chainId: dep.chainId, contract: dep.address }) };
  };
  if (!process.argv.includes("--watch")) {
    console.log(JSON.stringify(await run(), null, 2));
    return;
  }
  // Periodic auditor: record when each flag first appears.
  const out = arg("out", path.join(cfg.ROOT, "results", "audit_watch.csv"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, "auditTime,kind,rid,detail\n");
  const seen = new Set();
  const periodMs = Number(arg("period", 10)) * 1000;
  const untilMs = Date.now() + Number(arg("duration", 600)) * 1000;
  while (Date.now() < untilMs) {
    const r = await run();
    const flag = (kind, rid, detail = "") => {
      const k = `${kind}:${rid}`;
      if (seen.has(k)) return;
      seen.add(k);
      fs.appendFileSync(out, `${r.nowSec},${kind},${rid},${detail}\n`);
    };
    r.omitted.forEach((rid) => flag("OMITTED", rid));
    r.late.forEach((x) => flag("LATE", x.rid, x.delaySec));
    r.inconsistent.forEach((rid) => flag("MISMATCH", rid));
    r.invalid.forEach((rid) => flag("INVALID", rid));
    r.gaps.forEach((g) => flag("GAP", `${g.did}:${g.from}-${g.to}`));
    await new Promise((ok) => setTimeout(ok, periodMs));
  }
  console.log(`[auditor] wrote ${out}`);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { auditEntries, committedProofs, fetchWitnessLog };
