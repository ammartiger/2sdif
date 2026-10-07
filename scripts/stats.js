"use strict";
/**
 * Computes the paper's statistics from the raw CSVs and writes a results_values file.
 *   node scripts/stats.js --latency results/latency_localhost.csv --retrieve results/retrieve_localhost.csv \
 *        --sepolia results/latency_sepolia.csv --gas results/gas_hardhat.csv --device results/device_cost.csv \
 *        --attacks results/attacks_hardhat.csv [--witness-exec results/witness_exec.csv] [--rtt results/rtt_azure.csv] \
 *        [--sepolia-run results/sepolia_run.json] \
 *        --template <path>/results_values.tex --out <path>/results_values.tex
 * Mean with 95% CI (t distribution), median and 95th percentile (linear interpolation).
 * \measuredtrue is written only if every value the paper uses was measured; otherwise missing
 * values keep their expected placeholders and stay red.
 */
const fs = require("fs");
const path = require("path");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

function readCsv(file) {
  if (!file || !fs.existsSync(file)) return null;
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  const cols = head.split(",");
  return lines.map((l) => {
    const cells = l.match(/("([^"]*)"|[^,]+)/g).map((c) => c.replace(/^"|"$/g, ""));
    return Object.fromEntries(cols.map((c, i) => [c, cells[i]]));
  });
}

// Student-t 0.975 quantile via Cornish-Fisher expansion (accurate to ~1e-4 for df >= 5)
function t975(df) {
  const z = 1.959963985;
  const g1 = (z ** 3 + z) / 4, g2 = (5 * z ** 5 + 16 * z ** 3 + 3 * z) / 96, g3 = (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / 384;
  const g4 = (79 * z ** 9 + 776 * z ** 7 + 1482 * z ** 5 - 1920 * z ** 3 - 945 * z) / 92160;
  return z + g1 / df + g2 / df ** 2 + g3 / df ** 3 + g4 / df ** 4;
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function summary(values) {
  const v = values.map(Number).filter(Number.isFinite);
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const s = [...v].sort((a, b) => a - b);
  return { n, mean, ci: t975(n - 1) * sd / Math.sqrt(n), median: quantile(s, 0.5), p95: quantile(s, 0.95), min: s[0], max: s[n - 1], sd };
}
const fmt = (x, d) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d));
const thousands = (x) => String(Math.round(Number(x))).replace(/\B(?=(\d{3})+(?!\d))/g, "{,}");

/** Replace the body of \newcommand{\name}{...} (balanced braces), or append the definition. */
function replaceMacro(tex, name, value) {
  const key = `\\newcommand{\\${name}}{`;
  const at = tex.indexOf(key);
  if (at < 0) return tex + `\\newcommand{\\${name}}{${value}}\n`;
  let i = at + key.length, depth = 1;
  while (i < tex.length && depth > 0) {
    if (tex[i] === "{") depth++;
    else if (tex[i] === "}") depth--;
    i++;
  }
  return tex.slice(0, at + key.length) + value + "}" + tex.slice(i);
}

function main() {
  const out = {};
  const measured = {};
  const set = (k, v) => { out[k] = v; measured[k] = true; };
  const lat = readCsv(arg("latency"));
  const report = {};
  if (lat) {
    const map = { EE: "e2eMs", Dep: "depositMs", Lan: "transferMs", Fetch: "fetchMs", Ver: "verifyMs", Com: "commitMs", Per: "persistMs" };
    for (const [k, col] of Object.entries(map)) {
      const s = summary(lat.map((r) => r[col]));
      report[col] = s;
      set(`${k}Mean`, fmt(s.mean, 1)); set(`${k}CI`, fmt(s.ci, 1)); set(`${k}Med`, fmt(s.median, 1)); set(`${k}Pnf`, fmt(s.p95, 1));
    }
    set("NTrials", String(lat.length));
    set("NWarm", arg("warmup", "10"));
  }
  const ret = readCsv(arg("retrieve"));
  if (ret) { const s = summary(ret.map((r) => r.retrieveMs)); report.retrieveMs = s; set("RetMean", fmt(s.mean, 1)); set("RetCI", fmt(s.ci, 1)); set("RetMed", fmt(s.median, 1)); set("RetPnf", fmt(s.p95, 1)); }
  if (lat && lat[0].gasUsed !== undefined) {
    const lg = lat.map((r) => Number(r.gasUsed)).filter(Number.isFinite).sort((x, y) => x - y);
    if (lg.length) { set("GasCommitMin", thousands(lg[0])); set("GasCommitMax", thousands(lg[lg.length - 1])); }
  }
  const sep = readCsv(arg("sepolia"));
  if (sep) {
    const c = summary(sep.map((r) => r.commitMs / 1000)), e = summary(sep.map((r) => r.e2eMs / 1000));
    report.sepoliaCommitS = c; report.sepoliaE2eS = e;
    set("NSep", String(sep.length)); set("SepMed", c.median.toFixed(1)); set("SepMin", c.min.toFixed(1)); set("SepMax", c.max.toFixed(1)); set("SepEEMed", e.median.toFixed(1));
    const sg = sep.map((r) => Number(r.gasUsed)).filter(Number.isFinite).sort((x, y) => x - y);
    if (sg.length) { report.sepoliaGas = { min: sg[0], max: sg[sg.length - 1], median: quantile(sg, 0.5) }; set("SepGasCommitMin", thousands(sg[0])); set("SepGasCommitMax", thousands(sg[sg.length - 1])); set("SepGasCommitMed", thousands(quantile(sg, 0.5))); }
    const sw = summary(sep.map((r) => r.depositMs)), sf = summary(sep.map((r) => r.fetchMs));
    report.sepoliaWitness = { deposit: sw, fetch: sf };
    set("SepDepMed", fmt(sw.median, 0)); set("SepFetchMed", fmt(sf.median, 0));
    if (sep[0].depositExecMs !== undefined) {
      const sx = summary(sep.map((r) => r.depositExecMs)), sy = summary(sep.map((r) => r.fetchExecMs));
      report.sepoliaWitnessExec = { deposit: sx, attestation: sy };
      set("SepDepExecMed", fmt(sx.median, 1)); set("SepAttExecMed", fmt(sy.median, 1));
    }
  }
  const sepRun = arg("sepolia-run") && fs.existsSync(arg("sepolia-run")) ? JSON.parse(fs.readFileSync(arg("sepolia-run"), "utf8")) : null;
  if (sepRun) { report.sepoliaRun = sepRun; if (sepRun.deployGas) set("SepGasDeploy", thousands(sepRun.deployGas)); }
  const gas = readCsv(arg("gas"));
  if (gas) {
    const g = Object.fromEntries(gas.map((r) => [r.operation, r.gasUsed]));
    const gm = { GasDeploy: "Contract deployment", GasCommit: "commitProof (attested device record)", GasRegClin: "Register clinician", GasRegPat: "Register patient", GasAddPhi: "Add health information record", GasGrantPhi: "Grant health information access", GasRevokePhi: "Revoke health information access", GasAddRx: "Add prescription", GasGrantRx: "Grant prescription access", GasRevokeRx: "Revoke prescription access" };
    for (const [k, op] of Object.entries(gm)) if (g[op]) set(k, thousands(g[op]));
    report.gas = g;
  }
  const dev = readCsv(arg("device"));
  if (dev) {
    const h = summary(dev.map((r) => r.hashUs)), m = summary(dev.map((r) => r.hmacUs)), t = summary(dev.map((r) => r.totalUs));
    report.device = { hashUs: h, hmacUs: m, totalUs: t, bytes: dev[0].bytes };
    set("NDev", String(dev.length)); set("RecBytes", dev[0].bytes); set("DevHash", fmt(h.mean, 1)); set("DevHmac", fmt(m.mean, 1)); set("DevTotal", fmt(t.mean, 1));
    set("DevHashMed", fmt(h.median, 1)); set("DevHmacMed", fmt(m.median, 1)); set("DevTotalMed", fmt(t.median, 1));
  }
  const att = readCsv(arg("attacks"));
  if (att) {
    report.attacks = att;
    const t5 = att.find((r) => r.id === "T5");
    const others = att.filter((r) => r.id !== "T5");
    set("NAttacks", String(att.length));
    set("NAttackRuns", others[0].runs);
    if (t5) {
      const m = t5.scenario.match(/withholds (\d+) of (\d+) records \(flagged (\d+), false positives (\d+)\)/);
      if (m) { set("OmitWithheld", m[1]); set("OmitTotal", m[2]); set("OmitFlagged", m[3]); set("OmitFP", m[4]); }
    }
  }
  // Witness execution time: per-invocation handler time (x-exec-ms) of deposits and attestation reads,
  // taken from the latency CSV; an explicit --witness-exec CSV (column durationMs) overrides it.
  const wx = readCsv(arg("witness-exec"));
  let execVals = wx ? wx.map((r) => r.durationMs) : null;
  if (!execVals && lat && lat[0].depositExecMs !== undefined) {
    execVals = lat.flatMap((r) => [r.depositExecMs, r.fetchExecMs]).filter((x) => x !== "" && x !== undefined);
    const d = summary(lat.map((r) => r.depositExecMs)), f = summary(lat.map((r) => r.fetchExecMs));
    report.witnessExec = { deposit: d, attestation: f };
    set("WitDepExecMed", fmt(d.median, 1)); set("WitAttExecMed", fmt(f.median, 1));
    const tries = lat.map((r) => Number(r.fetchAttempts)).filter(Number.isFinite);
    if (tries.length) report.fetchAttempts = { max: Math.max(...tries), retried: tries.filter((x) => x > 1).length };
  }
  if (execVals && execVals.length) { const s = summary(execVals); report.witnessExecAll = s; set("WitExecMed", fmt(s.median, 1)); set("WitExecPnf", fmt(s.p95, 1)); }
  const rtt = readCsv(arg("rtt"));
  if (rtt) { const s = summary(rtt.map((r) => r.rttMs)); report.rtt = s; set("RttMed", fmt(s.median, 1)); set("RttMin", fmt(s.min, 1)); }

  // merge with the existing file so unmeasured values keep their placeholders
  const template = arg("template");
  let tex = template && fs.existsSync(template) ? fs.readFileSync(template, "utf8") : "";
  for (const [k, v] of Object.entries(out)) tex = replaceMacro(tex, k, v);
  const required = ["EEMean", "DepMean", "FetchMean", "ComMean", "SepMed", "GasCommit", "DevTotal", "NAttacks", "OmitFlagged", "RetMean", "WitExecMed"];
  const missing = required.filter((k) => !measured[k]);
  // Every template value that was not measured in this run is wrapped in \pending{...}, which the paper
  // prints in red (and refuses in final mode); measured values are plain. \measuredtrue then only turns
  // off the blanket red of \res{}, so measured and pending values can coexist in one build.
  const PARAMS = new Set(["GasEcrecoverShare", "OmitDelta"]); // constants and settings, not measurements
  const pendingNames = [];
  for (const name of [...tex.matchAll(/\\newcommand\{\\(\w+)\}\{/g)].map((x) => x[1])) {
    if (measured[name] || PARAMS.has(name)) continue;
    const key = `\\newcommand{\\${name}}{`;
    const at = tex.indexOf(key);
    let i = at + key.length, depth = 1;
    while (i < tex.length && depth > 0) { if (tex[i] === "{") depth++; else if (tex[i] === "}") depth--; i++; }
    const body = tex.slice(at + key.length, i - 1);
    if (!body.startsWith("\\pending{")) tex = tex.slice(0, at + key.length) + `\\pending{${body}}` + tex.slice(i - 1);
    pendingNames.push(name);
  }
  if (template) tex = tex.replace(/\\measured(true|false)/, "\\measuredtrue");
  const header = `%% Generated by scripts/stats.js on ${new Date().toISOString()}\n%% Not measured in this run (wrapped in \\pending, printed red): ${pendingNames.join(", ") || "none"}\n`;
  const outFile = arg("out", path.join(__dirname, "..", "results", "results_values.tex"));
  fs.writeFileSync(outFile, header + tex);
  fs.writeFileSync(outFile.replace(/\.tex$/, ".summary.json"), JSON.stringify(report, null, 2));
  console.log(`[stats] wrote ${outFile} (measured ${Object.keys(measured).length} values; missing: ${missing.join(", ") || "none"})`);
}

main();
