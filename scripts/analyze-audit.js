"use strict";
/**
 * Scores the periodic auditor against the ground truth of the omission experiment.
 *   node scripts/analyze-audit.js --truth results/audit_truth.csv --watch results/audit_watch.csv
 *        --delta 30 --skew 5 --period 10 [--network slot12] [--out results/audit_summary.json]
 *
 * Ground truth (from the device simulator): committed | withheld | delayed | suppressed per reading.
 * Expected flags:
 *   withheld   -> OMITTED (never committed)
 *   delayed    -> OMITTED while the commitment is outstanding, then LATE once it lands
 *   suppressed -> GAP covering its sequence number (the witness never saw it)
 *   committed  -> no flag (any flag is a false positive)
 * Detection delay = time of the first audit pass that raised the flag minus the witness time tW
 * (for GAP: minus the device's send time, since there is no tW).
 * Receipts: every withheld or delayed reading must carry a valid gateway receipt, which attributes the
 * omission to the gateway rather than to the device or the network.
 */
const fs = require("fs");
const path = require("path");
const P = require("../shared/protocol");
const cfg = require("../shared/config");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.filter(Boolean).map((l) => {
    const v = l.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
}
const stats = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => { const x = (s.length - 1) * p, lo = Math.floor(x), hi = Math.ceil(x); return s[lo] + (s[hi] - s[lo]) * (x - lo); };
  return { n: s.length, min: s[0], median: q(0.5), p95: q(0.95), max: s[s.length - 1] };
};

function analyze({ truth, watch, deltaSec, skewSec, periodSec, receipts, dep }) {
  const flags = new Map(); // rid -> { OMITTED: t, LATE: t, ... }
  const gaps = [];
  const other = [];
  for (const w of watch) {
    if (w.kind === "GAP") {
      const [did, range] = w.rid.split(":");
      const [from, to] = range.split("-").map(BigInt);
      gaps.push({ did: did.toLowerCase(), from, to, t: Number(w.auditTime) });
      continue;
    }
    const rid = w.rid.toLowerCase();
    if (!flags.has(rid)) flags.set(rid, {});
    const f = flags.get(rid);
    if (f[w.kind] === undefined) f[w.kind] = Number(w.auditTime);
    if (!["OMITTED", "LATE"].includes(w.kind)) other.push(w);
  }
  const bound = deltaSec + skewSec + periodSec; // worst-case detection delay for an omission (+ one block)
  const byOutcome = {};
  const fp = [];
  const fn = [];
  const delays = { withheld: [], delayedOmitted: [], delayedLate: [], suppressed: [] };
  const receiptOk = new Map();
  for (const r of receipts || []) {
    let ok = false;
    try { ok = P.recoverReceiptSigner({ chainId: dep.chainId, contract: dep.address, rid: r.rid, h: r.h }, r.receipt).toLowerCase() === dep.gateway.toLowerCase(); } catch {}
    receiptOk.set(r.rid.toLowerCase(), ok);
  }
  for (const t of truth) {
    byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;
    const rid = String(t.rid).toLowerCase();
    const f = flags.get(rid) || {};
    const tW = Number(t.tW);
    if (t.outcome === "committed") {
      if (Object.keys(f).length) fp.push({ rid, flags: f });
    } else if (t.outcome === "withheld") {
      if (f.OMITTED === undefined) fn.push({ rid, outcome: t.outcome });
      else delays.withheld.push(f.OMITTED - tW);
      if (f.LATE !== undefined) fp.push({ rid, flags: f });
    } else if (t.outcome === "delayed") {
      if (f.LATE === undefined) fn.push({ rid, outcome: t.outcome, missing: "LATE" });
      else delays.delayedLate.push(f.LATE - tW);
      if (f.OMITTED !== undefined) delays.delayedOmitted.push(f.OMITTED - tW);
    } else if (t.outcome === "suppressed") {
      const did = P.toBytes32Id(cfg.devices()[0].did).toLowerCase();
      const seq = BigInt(t.seq);
      const g = gaps.find((x) => x.did === did && x.from <= seq && seq <= x.to);
      if (!g) fn.push({ rid, outcome: t.outcome, missing: "GAP" });
      else delays.suppressed.push(g.t - Number(t.sentAt) / 1000);
    }
  }
  const attributable = truth.filter((t) => ["withheld", "delayed"].includes(t.outcome));
  return {
    parameters: { deltaSec, skewSec, periodSec, omissionDetectionBoundSec: bound },
    readings: truth.length,
    outcomes: byOutcome,
    falsePositives: fp.length,
    falseNegatives: fn.length,
    falsePositiveDetail: fp,
    falseNegativeDetail: fn,
    otherFlags: other.length,
    detectionDelaySec: {
      withheldAsOmitted: stats(delays.withheld),
      delayedFirstAsOmitted: stats(delays.delayedOmitted),
      delayedAsLate: stats(delays.delayedLate),
      suppressedAsGap: stats(delays.suppressed),
    },
    withinBound: delays.withheld.every((d) => d <= bound + 12),
    receipts: {
      required: attributable.length,
      valid: attributable.filter((t) => receiptOk.get(String(t.rid).toLowerCase())).length,
    },
  };
}

function main() {
  const truthFile = arg("truth", path.join(cfg.ROOT, "results", "audit_truth.csv"));
  const watchFile = arg("watch", path.join(cfg.ROOT, "results", "audit_watch.csv"));
  const recFile = arg("receipts", truthFile.replace(/\.csv$/, "") + ".receipts.json");
  const dep = cfg.deployment(arg("network", process.env.NETWORK || "slot12"));
  const out = analyze({
    truth: readCsv(truthFile),
    watch: fs.existsSync(watchFile) && fs.readFileSync(watchFile, "utf8").trim().split(/\r?\n/).length > 1 ? readCsv(watchFile) : [],
    deltaSec: Number(arg("delta", 30)),
    skewSec: Number(arg("skew", 5)),
    periodSec: Number(arg("period", 10)),
    receipts: fs.existsSync(recFile) ? JSON.parse(fs.readFileSync(recFile, "utf8")) : [],
    dep,
  });
  const file = arg("out", path.join(cfg.ROOT, "results", "audit_summary.json"));
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...out, falsePositiveDetail: undefined, falseNegativeDetail: undefined }, null, 2));
  console.log(`[audit-analysis] wrote ${file}`);
}

if (require.main === module) main();
module.exports = { analyze };
