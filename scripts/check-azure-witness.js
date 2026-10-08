"use strict";
/**
 * Tests the Azure Functions witness WITHOUT Azure:
 *  - starts the Azurite Table Storage emulator (real Table REST semantics, incl. 409 on duplicate insert),
 *  - loads witness/azure/src/functions/witness.js with a stub of @azure/functions that captures the handlers,
 *  - invokes the handlers exactly as the Functions host would, and
 *  - exposes them over HTTP (emulating the host's routing and function-key auth) so that the real gateway
 *    and device code can run the full store path against the Azure code path.
 * Usage: node scripts/check-azure-witness.js      (requires: npm i --no-save azurite@3; cd witness/azure && npm i)
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const assert = require("assert");
const { spawn } = require("child_process");
const Module = require("module");

const ROOT = path.join(__dirname, "..");
const AZ = path.join(ROOT, "witness", "azure");
require(path.join(ROOT, "scripts", "prepare-azure.js"));

// ---- stub @azure/functions so we can capture handler registrations -----------------------------
const registered = {};
const stub = { app: { http: (name, opts) => { registered[name] = opts; } } };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "@azure/functions") return "@azure/functions-stub";
  return origResolve.call(this, request, parent, ...rest);
};
require.cache["@azure/functions-stub"] = { id: "@azure/functions-stub", filename: "@azure/functions-stub", loaded: true, exports: stub };

function fakeRequest({ body, params = {}, query = {} }) {
  return { json: async () => body, params, query: new URLSearchParams(query) };
}

async function startAzurite() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azurite-"));
  const bin = path.join(ROOT, "node_modules", ".bin", "azurite-table");
  const proc = spawn(bin, ["--tableHost", "127.0.0.1", "--tablePort", "10002", "--location", dir, "--silent", "--skipApiVersionCheck"], { stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      await new Promise((ok, bad) => http.get("http://127.0.0.1:10002/", () => ok()).on("error", bad));
      return proc;
    } catch {}
  }
  proc.kill();
  throw new Error("Azurite did not start");
}

async function main() {
  const { ethers } = require(path.join(AZ, "node_modules", "ethers"));
  const P = require(path.join(AZ, "src", "shared", "protocol.js"));
  const azurite = await startAzurite();
  if (process.argv.includes("--serve")) return serve(azurite);
  const results = [];
  const check = (name, cond) => { results.push({ name, ok: !!cond }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };
  try {
    const witnessWallet = ethers.Wallet.createRandom();
    const did = P.toBytes32Id("sensor-az");
    const key = crypto.randomBytes(32).toString("hex");
    const contract = "0x" + "11".repeat(20);
    process.env.WITNESS_PRIVATE_KEY = witnessWallet.privateKey;
    process.env.DEVICE_KEYS = JSON.stringify({ [did]: key });
    process.env.CHAIN_ID = "31337";
    process.env.CONTRACT_ADDRESS = contract;
    process.env.WITNESS_TABLE_CONNECTION = "UseDevelopmentStorage=true";
    require(path.join(AZ, "src", "functions", "witness.js"));

    check("registers deposit, attestation, log and health functions", ["deposit", "attestation", "log", "health"].every((n) => registered[n]));
    check("deposit and attestation are anonymous; log requires a function key", registered.deposit.authLevel === "anonymous" && registered.attestation.authLevel === "anonymous" && registered.log.authLevel === "function");
    check("routes match the local emulator", registered.deposit.route === "deposit" && registered.attestation.route === "attestation/{rid}" && registered.log.route === "log");

    const dep = P.deploymentId(31337, contract);
    const seq = 1000n;
    const record = { did, seq: seq.toString(), pid: P.toBytes32Id("p"), hr: 70, nonce: P.randomNonceHex() };
    const rid = P.recordId(did, seq);
    const h = P.recordDigest(record);
    const t = Math.floor(Date.now() / 1000);
    const deposit = (o = {}) => {
      const d = { did, seq, h, t, dep, ...o };
      return { did: d.did, seq: d.seq.toString(), h: d.h, t: d.t, dep: d.dep, tag: o.tag || P.deviceTag(key, d) };
    };

    const r0 = await registered.health.handler();
    check("health reports the deployment binding (chain, contract, dep)", r0.jsonBody.chainId === "31337" && r0.jsonBody.contract.toLowerCase() === contract && r0.jsonBody.dep === dep);

    const r1 = await registered.deposit.handler(fakeRequest({ body: deposit() }));
    check("valid deposit is accepted (201) and returns a signature", r1.status === 201 && typeof r1.jsonBody.sig === "string");
    check("attestation names rid = H(did, seq)", r1.jsonBody.rid === rid.toLowerCase());
    const signer = P.recoverAttestationSigner({ chainId: 31337, contract, did: r1.jsonBody.did, seq: r1.jsonBody.seq, h: r1.jsonBody.h, tW: r1.jsonBody.tW }, r1.jsonBody.sig);
    check("attestation is signed by the witness key", signer === witnessWallet.address);
    check("responses carry x-exec-ms and an instance id", Number.isFinite(Number(r1.headers["x-exec-ms"])) && /^[0-9a-f]{8}$/.test(r1.headers["x-instance"]));

    const r2 = await registered.deposit.handler(fakeRequest({ body: deposit({ h: P.recordDigest({ other: 1 }) }) }));
    check("second deposit for the same (did, seq) is rejected by Table Storage (409, write once)", r2.status === 409);

    const r3 = await registered.deposit.handler(fakeRequest({ body: deposit({ seq: seq + 1n, tag: deposit().tag }) }));
    check("tag bound to a different sequence number is rejected (401)", r3.status === 401);

    const r3b = await registered.deposit.handler(fakeRequest({ body: deposit({ seq: seq + 2n, dep: P.deploymentId(1, contract) }) }));
    check("deposit for another deployment is rejected (400)", r3b.status === 400);

    const r4 = await registered.deposit.handler(fakeRequest({ body: deposit({ seq: seq + 3n, t: t - 3600 }) }));
    check("stale deposit is rejected (401)", r4.status === 401);

    const r5 = await registered.attestation.handler(fakeRequest({ params: { rid } }));
    check("attestation retrieval returns the stored entry", r5.status === 200 && r5.jsonBody.h === h.toLowerCase() && r5.jsonBody.sig === r1.jsonBody.sig && String(r5.jsonBody.seq) === seq.toString());

    const r6 = await registered.attestation.handler(fakeRequest({ params: { rid: P.randomBytes32() } }));
    check("unknown record id returns 404", r6.status === 404);

    const r7 = await registered.log.handler(fakeRequest({ query: { since: String(t - 10) } }));
    check("log lists the attested entry with its sequence number", r7.status === 200 && r7.jsonBody.entries.some((e) => e.rid === rid.toLowerCase() && String(e.seq) === seq.toString()));

    const bad = await registered.deposit.handler({ json: async () => { throw new Error("bad json"); } });
    check("malformed JSON is rejected (400)", bad.status === 400);

  } finally {
    azurite.kill();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} Azure witness checks passed`);
  process.exit(failed ? 1 : 0);
}

/** Host emulation: real deployment config, Azurite-backed handlers, function-key check on /api/log. */
async function serve(azurite) {
  const cfg = require(path.join(ROOT, "shared", "config"));
  const dep = cfg.deployment();
  const keys = {};
  for (const d of cfg.devices()) keys[d.did] = d.key;
  process.env.DEVICE_KEYS = JSON.stringify(keys);
  process.env.CHAIN_ID = String(dep.chainId);
  process.env.CONTRACT_ADDRESS = dep.address;
  process.env.WITNESS_TABLE_CONNECTION = "UseDevelopmentStorage=true";
  require(path.join(AZ, "src", "functions", "witness.js"));
  const fnKey = process.env.AUDITOR_KEY;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", (c) => (body += c));
    await new Promise((r) => req.on("end", r));
    let out;
    const m = url.pathname.match(/^\/api\/attestation\/(0x[0-9a-fA-F]{64})$/);
    if (req.method === "GET" && url.pathname === "/api/health") out = await registered.health.handler();
    else if (req.method === "POST" && url.pathname === "/api/deposit") out = await registered.deposit.handler({ json: async () => JSON.parse(body) });
    else if (req.method === "GET" && m) out = await registered.attestation.handler(fakeRequest({ params: { rid: m[1] } }));
    else if (req.method === "GET" && url.pathname === "/api/log") {
      out = fnKey && req.headers["x-functions-key"] === fnKey ? await registered.log.handler(fakeRequest({ query: Object.fromEntries(url.searchParams) })) : { status: 401, jsonBody: { error: "function key required" } };
    } else out = { status: 404, jsonBody: { error: "no route" } };
    res.writeHead(out.status || 200, { "content-type": "application/json", ...(out.headers || {}) });
    res.end(JSON.stringify(out.jsonBody));
  });
  const port = Number(process.env.WITNESS_PORT || 7072);
  await new Promise((r) => srv.listen(port, "127.0.0.1", r));
  console.log(`[azure-host-emulation] Azure witness handlers on http://127.0.0.1:${port}/api (Azurite Table Storage)`);
  process.on("SIGTERM", () => { azurite.kill(); process.exit(0); });
}

main().catch((e) => { console.error(e); process.exit(1); });
