"use strict";
/**
 * Load experiments.
 *
 *   node scripts/bench-load.js witness --levels 1,10,50,100,200 --rounds 3 [--out-prefix results/load]
 *       Closed bursts: k deposits sent at once straight to the witness (channel 2 only).
 *   node scripts/bench-load.js rate --rates 5,20,50,100 --duration 20 [--out-prefix results/load]
 *       Open loop: deposits issued at a fixed rate whether or not earlier ones have completed.
 *   node scripts/bench-load.js e2e --devices 1,10,50,100 --per-device 10 [--out-prefix results/load]
 *       Full store path: k devices submit concurrently through one gateway (one gateway key).
 *
 * Each request records its latency, status, the witness's own execution time (x-exec-ms), the serving
 * instance (x-instance) and whether that instance was serving its first request (x-cold).
 * Env: NETWORK, WITNESS_URL, GATEWAY_URL, KEEPALIVE_MS. Needs devices.json (scripts/gen-keys.js --extend 100).
 */
const fs = require("fs");
const path = require("path");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { configureHttp } = require("../shared/http");
const { Device } = require("../device/device");

const argv = process.argv.slice(2);
const MODE = argv[0];
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i > 0 ? argv[i + 1] : d; };
const list = (s) => String(s).split(",").map(Number).filter((x) => x > 0);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "");

function writeCsv(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
  console.log(`[load] wrote ${rows.length} rows to ${file}`);
}

function devicesFor(k, dep) {
  const all = cfg.devices();
  // distinct devices up to the number of keys; beyond that, extra sessions of the same keys with disjoint
  // sequence ranges (reported in the output as `sharedKey`)
  return Array.from({ length: k }, (_, j) => {
    const d = all[j % all.length];
    const dev = new Device({ ...d, dep, seqStart: BigInt(Date.now()) * 1000000n + BigInt(j) * 1000n });
    dev.sharedKey = j >= all.length;
    return dev;
  });
}

async function deposit(dev, witnessUrl) {
  const { deposit: body } = dev.prepare(dev.makeReading());
  const t0 = P.nowMs();
  let status = 0, execMs = NaN, instance = "", cold = "", err = "";
  try {
    const r = await fetch(`${witnessUrl}/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await r.arrayBuffer();
    status = r.status;
    execMs = Number(r.headers.get("x-exec-ms"));
    instance = r.headers.get("x-instance") || "";
    cold = r.headers.get("x-cold") || "";
  } catch (e) {
    err = (e.cause && e.cause.code) || e.message;
  }
  return { latencyMs: P.nowMs() - t0, status, execMs, instance, cold, err };
}

async function witnessBursts(witnessUrl, dep, out) {
  const rows = [];
  const rounds = Number(arg("rounds", 3));
  for (const k of list(arg("levels", "1,10,50,100,200"))) {
    for (let round = 1; round <= rounds; round++) {
      const devs = devicesFor(k, dep);
      const t0 = P.nowMs();
      const rs = await Promise.all(devs.map((d) => deposit(d, witnessUrl)));
      const wallMs = P.nowMs() - t0;
      rs.forEach((r, i) => rows.push({ level: k, round, i: i + 1, wallMs: f3(wallMs), latencyMs: f3(r.latencyMs), status: r.status, execMs: f3(r.execMs), instance: r.instance, cold: r.cold, err: r.err }));
      const ok = rs.filter((r) => r.status === 201).length;
      console.log(`[load] burst k=${k} round ${round}: ${ok}/${k} accepted in ${wallMs.toFixed(0)} ms, ${new Set(rs.map((r) => r.instance)).size} instance(s)`);
      await sleep(2000);
    }
  }
  writeCsv(`${out}_witness_burst.csv`, rows);
}

async function witnessRates(witnessUrl, dep, out) {
  const rows = [];
  const duration = Number(arg("duration", 20));
  const devs = devicesFor(Math.min(cfg.devices().length, 100), dep);
  for (const rate of list(arg("rates", "5,20,50,100"))) {
    const n = Math.round(rate * duration);
    const interval = 1000 / rate;
    const start = P.nowMs();
    const pending = [];
    for (let i = 0; i < n; i++) {
      const due = start + i * interval;
      const wait = due - P.nowMs();
      if (wait > 0) await sleep(wait);
      const lagMs = P.nowMs() - due; // how late the client issued the request (client-side saturation check)
      const dev = devs[i % devs.length];
      pending.push(deposit(dev, witnessUrl).then((r) => rows.push({ rate, i: i + 1, issuedAtMs: f3(due - start), lagMs: f3(lagMs), latencyMs: f3(r.latencyMs), status: r.status, execMs: f3(r.execMs), instance: r.instance, cold: r.cold, err: r.err })));
    }
    await Promise.all(pending);
    const mine = rows.filter((r) => r.rate === rate);
    const ok = mine.filter((r) => r.status === 201).length;
    console.log(`[load] rate ${rate}/s for ${duration} s: ${ok}/${n} accepted, ${new Set(mine.map((r) => r.instance)).size} instance(s)`);
    await sleep(5000);
  }
  rows.sort((a, b) => a.rate - b.rate || a.i - b.i);
  writeCsv(`${out}_witness_rate.csv`, rows);
}

async function endToEnd(urls, dep, out) {
  const rows = [];
  const summary = [];
  const per = Number(arg("per-device", 10));
  for (const k of list(arg("devices", "1,10,50,100"))) {
    const devs = devicesFor(k, dep);
    const t0 = P.nowMs();
    await Promise.all(devs.map(async (dev, j) => {
      for (let i = 0; i < per; i++) {
        let r;
        try {
          r = await dev.submit(dev.makeReading(), urls);
        } catch (e) {
          r = { ok: false, stage: "client", status: 0, body: { error: (e.cause && e.cause.code) || e.message } };
        }
        rows.push({ devices: k, device: j + 1, sharedKey: dev.sharedKey ? 1 : 0, i: i + 1, ok: r.ok ? 1 : 0, stage: r.stage, status: r.status, error: r.ok ? "" : (r.body && r.body.error) || "", e2eMs: f3(r.e2eMs), depositMs: f3(r.depositMs), fetchMs: f3(r.fetchMs), verifyMs: f3(r.verifyMs), commitMs: f3(r.commitMs), persistMs: f3(r.persistMs), transferMs: f3(r.transferMs), gasUsed: r.gasUsed || "" });
      }
    }));
    const wallMs = P.nowMs() - t0;
    const mine = rows.filter((r) => r.devices === k);
    const ok = mine.filter((r) => r.ok).length;
    summary.push({ devices: k, records: mine.length, committed: ok, wallMs: f3(wallMs), throughputPerSec: f3(ok / (wallMs / 1000)) });
    console.log(`[load] e2e k=${k}: ${ok}/${mine.length} committed in ${(wallMs / 1000).toFixed(1)} s (${(ok / (wallMs / 1000)).toFixed(1)} records/s)`);
    await sleep(2000);
  }
  writeCsv(`${out}_e2e.csv`, rows);
  writeCsv(`${out}_e2e_summary.csv`, summary);
}

async function main() {
  configureHttp();
  const d = cfg.deployment(cfg.network());
  const dep = P.deploymentId(d.chainId, d.address);
  const urls = {
    witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""),
    gatewayUrl: (process.env.GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/$/, ""),
  };
  const out = arg("out-prefix", path.join(cfg.ROOT, "results", "load"));
  if (MODE === "witness") return witnessBursts(urls.witnessUrl, dep, out);
  if (MODE === "rate") return witnessRates(urls.witnessUrl, dep, out);
  if (MODE === "e2e") return endToEnd(urls, dep, out);
  console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 16).join("\n"));
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
