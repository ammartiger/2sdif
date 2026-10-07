"use strict";
/**
 * Device simulator CLI.
 *   node device/simulator.js --n 50 --warmup 10 --out results/latency_localhost.csv
 *   node device/simulator.js --crypto 1000 --out results/device_cost.csv     (digest + HMAC cost only)
 *   node device/simulator.js --n 20 --warmup 2 --jitter 12000 --retries 2   (public chain: random pause per trial;
 *                                                                           failed attempts are retried and logged)
 * Env: NETWORK, WITNESS_URL (e.g. https://<app>.azurewebsites.net/api), GATEWAY_URL (default http://127.0.0.1:3001)
 */
const fs = require("fs");
const path = require("path");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { Device } = require("./device");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function writeCsv(file, rows, quiet = false) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
  if (!quiet) console.log(`[device] wrote ${rows.length} rows to ${file}`);
}

async function benchCrypto(dev, n, outFile) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const rec = dev.makeReading();
    const rid = P.randomBytes32();
    const t0 = P.nowMs();
    const h = P.recordDigest(rec);
    const t1 = P.nowMs();
    P.deviceTag(dev.key, { did: dev.did, rid, h, t: Math.floor(Date.now() / 1000) });
    const t2 = P.nowMs();
    rows.push({ trial: i + 1, bytes: Buffer.byteLength(P.canonicalize(rec)), hashUs: ((t1 - t0) * 1000).toFixed(3), hmacUs: ((t2 - t1) * 1000).toFixed(3), totalUs: ((t2 - t0) * 1000).toFixed(3) });
  }
  writeCsv(outFile, rows);
}

async function benchStore(dev, n, warmup, outFile, urls, jitterMs = 0, retries = 0) {
  const rows = [];
  const failures = [];
  const failFile = outFile.replace(/\.csv$/, "") + ".failures.json";
  for (let i = 0; i < warmup + n; i++) {
    let r;
    for (let attempt = 0; ; attempt++) {
      // random pause so that submissions sample the block/slot phase uniformly (public chains)
      if (jitterMs > 0) await new Promise((ok) => setTimeout(ok, Math.random() * jitterMs));
      r = await dev.submit(dev.makeReading(), urls);
      if (r.ok) break;
      failures.push({ trial: i + 1, attempt: attempt + 1, stage: r.stage, status: r.status, body: r.body, at: new Date().toISOString() });
      fs.mkdirSync(path.dirname(failFile), { recursive: true });
      fs.writeFileSync(failFile, JSON.stringify(failures, null, 2));
      console.log(`[device] trial ${i + 1} attempt ${attempt + 1} failed at ${r.stage}: ${r.status} ${JSON.stringify(r.body)}`);
      if (attempt >= retries) throw new Error(`trial ${i + 1} failed at ${r.stage}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    if (i >= warmup) {
      rows.push({
        trial: i - warmup + 1,
        depositMs: r.depositMs.toFixed(3),
        transferMs: r.transferMs.toFixed(3),
        fetchMs: r.fetchMs.toFixed(3),
        verifyMs: r.verifyMs.toFixed(3),
        commitMs: r.commitMs.toFixed(3),
        persistMs: r.persistMs.toFixed(3),
        e2eMs: r.e2eMs.toFixed(3),
        gasUsed: r.gasUsed,
        depositExecMs: Number.isFinite(r.depositExecMs) ? r.depositExecMs.toFixed(3) : "",
        fetchExecMs: Number.isFinite(r.fetchExecMs) ? r.fetchExecMs.toFixed(3) : "",
        fetchAttempts: r.fetchAttempts ?? "",
      });
      writeCsv(outFile, rows, true); // keep partial results if a later trial fails
    }
  }
  writeCsv(outFile, rows);
  if (failures.length) console.log(`[device] ${failures.length} failed attempt(s) recorded in ${failFile}`);
}

async function main() {
  const devices = cfg.devices();
  const label = arg("device", devices[0].label);
  const dev = new Device(devices.find((d) => d.label === label));
  const net = cfg.network();
  if (arg("crypto")) return benchCrypto(dev, Number(arg("crypto")), arg("out", path.join(cfg.ROOT, "results", "device_cost.csv")));
  const urls = {
    witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""),
    gatewayUrl: (process.env.GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/$/, ""),
  };
  await benchStore(dev, Number(arg("n", 50)), Number(arg("warmup", 10)), arg("out", path.join(cfg.ROOT, "results", `latency_${net}.csv`)), urls, Number(arg("jitter", 0)), Number(arg("retries", 0)));
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
