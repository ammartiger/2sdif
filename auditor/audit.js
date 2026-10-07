"use strict";
/**
 * Omission auditor (Algorithm 3). Compares the witness log with ProofCommitted events.
 *   node auditor/audit.js --delta 30 [--from-block 0]
 * Env: NETWORK, WITNESS_URL, AUDITOR_KEY (sent as x-auditor-key and x-functions-key).
 */
const { ethers } = require("ethers");

/** Pure audit logic, used by the CLI and by the tests. */
function auditEntries({ entries, committed, nowSec, deltaSec }) {
  const omitted = [];
  const inconsistent = [];
  const logged = new Set();
  for (const e of entries) {
    logged.add(e.rid);
    if (e.tW >= nowSec - deltaSec) continue; // still within the inclusion bound
    const c = committed.get(e.rid);
    if (!c) omitted.push(e.rid);
    else if (c.digest.toLowerCase() !== e.h.toLowerCase()) inconsistent.push(e.rid);
  }
  const unattested = [...committed.keys()].filter((rid) => !logged.has(rid));
  return { omitted, inconsistent, unattested };
}

async function committedProofs(contract, fromBlock = 0) {
  const events = await contract.queryFilter(contract.filters.ProofCommitted(), fromBlock);
  const m = new Map();
  for (const ev of events) m.set(ev.args.rid.toLowerCase(), { digest: ev.args.digest, block: ev.blockNumber });
  return m;
}

async function fetchWitnessLog(witnessUrl, auditorKey, sinceSec = 0) {
  const r = await fetch(`${witnessUrl}/log?since=${sinceSec}`, { headers: { "x-auditor-key": auditorKey, "x-functions-key": auditorKey } });
  if (r.status !== 200) throw new Error(`witness log returned ${r.status}`);
  return (await r.json()).entries;
}

async function main() {
  const cfg = require("../shared/config");
  const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
  const net = cfg.network();
  const dep = cfg.deployment(net);
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl(net));
  const artifact = require("../artifacts/contracts/TwoSDIFRegistry.sol/TwoSDIFRegistry.json");
  const contract = new ethers.Contract(dep.address, artifact.abi, provider);
  const entries = await fetchWitnessLog((process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""), process.env.AUDITOR_KEY);
  const committed = await committedProofs(contract, Number(arg("from-block", dep.block || 0)));
  const nowSec = Math.floor(Date.now() / 1000);
  const report = auditEntries({ entries, committed, nowSec, deltaSec: Number(arg("delta", 30)) });
  console.log(JSON.stringify({ logEntries: entries.length, committed: committed.size, ...report }, null, 2));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { auditEntries, committedProofs, fetchWitnessLog };
