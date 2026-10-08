"use strict";
/**
 * Single-channel baseline gateways for the evaluation (same store-then-commit structure as the 2SDIF
 * gateway, without the witness):
 *   B0  trusted gateway: commits the digest it computed itself (no device authentication on chain)
 *   B1  device secp256k1 signature, checked here and on chain with ecrecover
 *   B2  device P-256 signature, checked here and on chain with the P256VERIFY precompile (EIP-7951)
 * POST /ingest/:mode  { did, seq, record, sig }   (sig: 65-byte hex for B1, { r, s } for B2)
 *
 *   node gateway/baselines.js        (Env: NETWORK, GATEWAY_PRIVATE_KEY, BASELINE_PORT default 3002)
 * Needs deployments/baselines_<net>.json written by scripts/deploy-baselines.js.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { ethers } = require("ethers");
const P = require("../shared/protocol");

function createBaselineGateway({ contracts, chainId, store, keys, log = () => {} }) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  const runner = contracts.B0.runner;
  let sendChain = Promise.resolve();
  function serialSend(fn) {
    const p = sendChain.then(async () => {
      try {
        return await fn();
      } catch (e) {
        if (runner && typeof runner.reset === "function") runner.reset();
        throw e;
      }
    });
    sendChain = p.catch(() => {});
    return p;
  }
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const types = ["string", "uint256", "address", "bytes32", "uint64", "bytes32"];

  app.post("/ingest/:mode", wrap(async (req, res) => {
    const t0 = P.nowMs();
    const mode = req.params.mode;
    const c = contracts[mode];
    if (!c) return res.status(404).json({ error: "unknown baseline" });
    const { did, seq, record, sig } = req.body || {};
    let seqN;
    try { seqN = BigInt(seq); } catch { seqN = -1n; }
    if (!P.isBytes32(did) || seqN < 0n || !record || String(record.did).toLowerCase() !== did.toLowerCase() || String(record.seq) !== seqN.toString()) {
      return res.status(400).json({ error: "malformed request" });
    }
    const rid = P.recordId(did, seqN);
    const h = P.recordDigest(record);
    const tP0 = P.nowMs();
    await store.put(`baseline-${mode}`, rid, { record, digest: h, status: "pending", receivedAt: Date.now() });
    let persistMs = P.nowMs() - tP0;

    // off-chain pre-check of the device signature (the contract repeats it)
    const tV = P.nowMs();
    if (mode === "B1") {
      const m = ethers.keccak256(abi.encode(types, ["2SDIF-B1", BigInt(chainId), c.target, did, seqN, h]));
      let signer = null;
      try { signer = ethers.verifyMessage(ethers.getBytes(m), sig); } catch {}
      if (!signer || signer.toLowerCase() !== keys.B1.toLowerCase()) return res.status(409).json({ error: "InvalidSignature", rid });
    } else if (mode === "B2") {
      const m = ethers.getBytes(abi.encode(types, ["2SDIF-B2", BigInt(chainId), c.target, did, seqN, h]));
      const raw = Buffer.concat([Buffer.from(String(sig && sig.r).replace(/^0x/, ""), "hex"), Buffer.from(String(sig && sig.s).replace(/^0x/, ""), "hex")]);
      let ok = false;
      try { ok = raw.length === 64 && crypto.verify("sha256", m, { key: keys.B2, dsaEncoding: "ieee-p1363" }, raw); } catch {}
      if (!ok) return res.status(409).json({ error: "InvalidSignature", rid });
    }
    const verifyMs = P.nowMs() - tV;

    const tC = P.nowMs();
    let rc;
    try {
      const tx = await serialSend(() =>
        mode === "B0" ? c.commit(did, seqN, h) : mode === "B1" ? c.commit(did, seqN, h, sig) : c.commit(did, seqN, h, sig.r, sig.s));
      rc = await tx.wait();
    } catch (e) {
      return res.status(409).json({ error: "CommitFailed", detail: e.shortMessage || e.message, rid });
    }
    const commitMs = P.nowMs() - tC;
    const tP = P.nowMs();
    await store.put(`baseline-${mode}`, rid, { record, digest: h, status: "committed", txHash: rc.hash, receivedAt: Date.now() });
    persistMs += P.nowMs() - tP;
    res.json({ status: "Success", rid, digest: h, txHash: rc.hash, gasUsed: rc.gasUsed.toString(), blockNumber: rc.blockNumber, timings: { verifyMs, commitMs, persistMs, totalMs: P.nowMs() - t0 } });
  }));

  app.get("/health", (_req, res) => res.json({ ok: true, B0: contracts.B0.target, B1: contracts.B1.target, B2: contracts.B2.target }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log(`[baselines] error: ${err && err.message}`);
    res.status(500).json({ error: "InternalError", detail: err && (err.shortMessage || err.message) });
  });
  return app;
}

async function main() {
  const cfg = require("../shared/config");
  const { JsonStore } = require("./store");
  const { configureHttp } = require("../shared/http");
  configureHttp();
  const net = cfg.network();
  const b = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, "deployments", `baselines_${net}.json`), "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl(net), undefined, { pollingInterval: Number(process.env.POLL_MS || (net === "sepolia" ? 1000 : 10)), cacheTimeout: -1 });
  const wallet = new ethers.NonceManager(new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY, provider));
  const art = (n) => require(`../artifacts/contracts/Baselines.sol/${n}.json`).abi;
  const contracts = {
    B0: new ethers.Contract(b.B0, art("TrustedGatewayRegistry"), wallet),
    B1: new ethers.Contract(b.B1, art("DeviceSignedRegistry"), wallet),
    B2: new ethers.Contract(b.B2, art("DeviceP256Registry"), wallet),
  };
  const keys = { B1: b.deviceKeyB1, B2: crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b.deviceKeyB2.x, y: b.deviceKeyB2.y }, format: "jwk" }) };
  const app = createBaselineGateway({ contracts, chainId: b.chainId, store: new JsonStore(process.env.DATA_DIR || path.join(cfg.ROOT, "data", `baselines_${net}`)), keys, log: console.log });
  const port = Number(process.env.BASELINE_PORT || 3002);
  app.listen(port, () => console.log(`[baselines] ${net} on http://127.0.0.1:${port}  B0 ${b.B0}  B1 ${b.B1}  B2 ${b.B2}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createBaselineGateway };
