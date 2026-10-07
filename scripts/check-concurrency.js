"use strict";
/**
 * Concurrency check: N devices submit at the same time; every record must be committed exactly once.
 *   node scripts/check-concurrency.js [N=20]      (needs chain, witness and gateway running)
 */
const cfg = require("../shared/config");
const { Device } = require("../device/device");

(async () => {
  const devs = cfg.devices().map((d) => new Device(d));
  const urls = {
    witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""),
    gatewayUrl: (process.env.GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/$/, ""),
  };
  const N = Number(process.argv[2] || 20);
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => devs[i % devs.length].submit(devs[i % devs.length].makeReading(), urls)));
  const ok = rs.filter((r) => r.ok).length;
  const failures = rs.filter((r) => !r.ok).map((r) => ({ stage: r.stage, status: r.status, error: r.body && r.body.error }));
  console.log(JSON.stringify({ concurrent: N, committed: ok, failures: failures.slice(0, 5), wallMs: Date.now() - t0 }));
  process.exit(ok === N ? 0 : 1);
})();
