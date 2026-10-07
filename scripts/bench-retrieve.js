"use strict";
/**
 * Retrieval benchmark: a patient reads its own device records through the gateway and verifies each one
 * against the committed digest (authorization call + client-side SHA-256 check).
 *   node scripts/bench-retrieve.js --n 50 --warmup 10 [--out results/retrieve_<net>.csv]
 * Needs: a running chain, witness and gateway; ADMIN_PRIVATE_KEY (defaults to Hardhat account #0 on localhost).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { Device } = require("../device/device");

const HARDHAT_ACCOUNT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // public test key
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

async function main() {
  const net = cfg.network();
  const dep = cfg.deployment(net);
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl(net), undefined, { pollingInterval: net === "localhost" ? 10 : 1000, cacheTimeout: -1 });
  const admin = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY || (net === "localhost" ? HARDHAT_ACCOUNT0 : ""), provider);
  const abi = require("../artifacts/contracts/TwoSDIFRegistry.sol/TwoSDIFRegistry.json").abi;
  const c = new ethers.Contract(dep.address, abi, admin);
  const gatewayUrl = (process.env.GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  const witnessUrl = (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, "");
  const dev = new Device(cfg.devices()[0]);
  const n = Number(arg("n", 50)), warmup = Number(arg("warmup", 10));

  // patient and responsible clinician for this device's pid (idempotent)
  const patient = ethers.Wallet.createRandom();
  const clinician = ethers.Wallet.createRandom();
  const p = await c.patients(dev.pid);
  if (!p.exists) {
    await (await c.registerClinician(clinician.address, P.recordDigest({ role: "bench-clinician" }))).wait();
    await (await c.registerPatient(dev.pid, patient.address, clinician.address, P.recordDigest({ role: "bench-patient" }))).wait();
  } else {
    throw new Error("patient for this device already registered; use a fresh deployment");
  }

  // sign in as the patient
  const nonce = await (await fetch(`${gatewayUrl}/auth/nonce?address=${patient.address}`)).json();
  const login = await (await fetch(`${gatewayUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: patient.address, nonce: nonce.nonce, signature: await patient.signMessage(nonce.message) }) })).json();
  const auth = { authorization: `Bearer ${login.token}` };

  // store records to read back
  const rids = [];
  for (let i = 0; i < n + warmup; i++) {
    const r = await dev.submit(dev.makeReading(), { witnessUrl, gatewayUrl });
    if (!r.ok) throw new Error(`store failed: ${JSON.stringify(r.body)}`);
    rids.push(r.rid);
  }
  const rows = [];
  for (let i = 0; i < rids.length; i++) {
    const t0 = P.nowMs();
    const res = await fetch(`${gatewayUrl}/device/${rids[i]}`, { headers: auth });
    const item = await res.json();
    const onchain = await c.getProof(rids[i]);
    const verified = res.status === 200 && P.recordDigest(item.record) === onchain.digest.toLowerCase();
    const ms = P.nowMs() - t0;
    if (!verified) throw new Error(`retrieval ${i} not verified (status ${res.status})`);
    if (i >= warmup) rows.push({ trial: i - warmup + 1, retrieveMs: ms.toFixed(3), verified });
  }
  const out = arg("out", path.join(cfg.ROOT, "results", `retrieve_${net}.csv`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, ["trial,retrieveMs,verified", ...rows.map((r) => `${r.trial},${r.retrieveMs},${r.verified}`)].join("\n") + "\n");
  console.log(`[retrieve] wrote ${rows.length} rows to ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
