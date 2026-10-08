"use strict";
/**
 * Cold-start probe for the deployed witness. Sends one deposit after the witness has been idle or restarted,
 * then a few deposits on the warm instance, and finally one deposit over a NEW connection to the warm
 * instance (so the first request's TLS handshake can be separated from instance start-up).
 *   node scripts/bench-cold.js --label idle-1 --chain-id 31337 --contract 0x... [--idle-sec 1200] [--warm 5]
 * Appends one row to results/coldstart.csv. Env: WITNESS_URL.
 * The witness marks the first request an instance serves with x-cold: 1 and names the instance (x-instance).
 */
const fs = require("fs");
const path = require("path");
const { fetch, Agent } = require("undici");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { connectionCount } = require("../shared/http");
const { Device } = require("../device/device");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function main() {
  const witnessUrl = (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, "");
  const dep = P.deploymentId(arg("chain-id"), arg("contract"));
  const dev = new Device({ ...cfg.devices()[0], dep });
  const pooled = new Agent({ keepAliveTimeout: 60000 });
  const send = async (dispatcher) => {
    const { deposit } = dev.prepare(dev.makeReading());
    const c0 = connectionCount();
    const t0 = P.nowMs();
    try {
      const r = await fetch(`${witnessUrl}/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(deposit), dispatcher });
      await r.arrayBuffer();
      return { ms: P.nowMs() - t0, status: r.status, cold: r.headers.get("x-cold") || "", instance: r.headers.get("x-instance") || "", execMs: Number(r.headers.get("x-exec-ms")), conns: connectionCount() - c0 };
    } catch (e) {
      return { ms: P.nowMs() - t0, status: 0, error: (e.cause && e.cause.code) || e.message, conns: connectionCount() - c0 };
    }
  };

  // first request: retry on errors and 5xx (an app that is still restarting), counting the total wait
  const tStart = P.nowMs();
  let first, attempts = 0;
  for (; attempts < 20; ) {
    attempts += 1;
    first = await send(pooled);
    if (first.status && first.status < 500) break;
    await sleep(3000);
  }
  const untilFirstOkMs = P.nowMs() - tStart;
  const warm = [];
  for (let i = 0; i < Number(arg("warm", 5)); i++) warm.push(await send(pooled));
  const fresh = await send(new Agent()); // new connection to the (now warm) instance
  const row = {
    label: arg("label", "probe"),
    at: new Date().toISOString(),
    idleSec: arg("idle-sec", ""),
    attempts,
    untilFirstOkMs: untilFirstOkMs.toFixed(1),
    firstMs: first.ms.toFixed(1),
    firstStatus: first.status,
    firstCold: first.cold,
    firstInstance: first.instance,
    firstExecMs: Number.isFinite(first.execMs) ? first.execMs.toFixed(1) : "",
    firstConns: first.conns,
    warmMedianMs: median(warm.map((w) => w.ms)).toFixed(1),
    warmInstance: [...new Set(warm.map((w) => w.instance))].join("|"),
    warmNewConnMs: fresh.ms.toFixed(1),
    warmNewConnStatus: fresh.status,
  };
  const file = path.join(cfg.ROOT, "results", "coldstart.csv");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, Object.keys(row).join(",") + "\n");
  fs.appendFileSync(file, Object.values(row).join(",") + "\n");
  console.log(`[cold] ${row.label}: first ${row.firstMs} ms (status ${row.firstStatus}, cold=${row.firstCold}, instance ${row.firstInstance}, ${attempts} attempt(s)); warm median ${row.warmMedianMs} ms; warm with new connection ${row.warmNewConnMs} ms`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
