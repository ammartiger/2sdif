"use strict";
/**
 * 2SDIF fog gateway (Express).
 *
 * Device path (POST /ingest): recompute SHA-256 over the canonical record, fetch the witness
 * attestation for the record id, reject early if the digests differ, and submit commitProof.
 * The contract, not this gateway, is the decisive check: it only accepts witness-attested digests.
 *
 * User path: users sign their own contract transactions (records, ACL changes) with MetaMask.
 * The gateway stores an off-chain record only after confirming its digest is committed on chain
 * by an authorized sender, and serves records only after an on-chain authorization check.
 *
 * Authentication: Sign-In-with-Ethereum style nonce (CSPRNG, single use, expiring) and
 * per-session bearer tokens. No shared "current user" state.
 */
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const P = require("../shared/protocol");

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

function createGateway({ contract, witnessUrl, witnessAddress, chainId, store, domain = "localhost", fetchRetries = 5, fetchBackoffMs = 40, log = () => {} }) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "64kb" }));

  const contractAddress = contract.target;
  const nonces = new Map(); // nonce -> { address, message, expires, used }
  const sessions = new Map(); // token -> { address, expires }

  // Express 4 does not catch rejected promises: route every async handler through wrap().
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // Transactions from the gateway key are sent one at a time so that nonces are assigned in order;
  // a failed send (e.g. a revert during gas estimation) resets the nonce manager inside the lock.
  let sendChain = Promise.resolve();
  function serialSend(fn) {
    const p = sendChain.then(async () => {
      try {
        return await fn();
      } catch (e) {
        if (contract.runner && typeof contract.runner.reset === "function") contract.runner.reset();
        throw e;
      }
    });
    sendChain = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------ auth
  app.get("/auth/nonce", (req, res) => {
    const address = String(req.query.address || "");
    if (!ethers.isAddress(address)) return res.status(400).json({ error: "address required" });
    const nonce = crypto.randomBytes(16).toString("hex");
    const issued = new Date();
    const expires = new Date(issued.getTime() + NONCE_TTL_MS);
    const message = P.loginMessage({ domain, address: ethers.getAddress(address), nonce, issuedAt: issued.toISOString(), expiresAt: expires.toISOString(), chainId: String(chainId) });
    nonces.set(nonce, { address: address.toLowerCase(), message, expires: expires.getTime(), used: false });
    res.json({ nonce, message });
  });

  app.post("/auth/login", (req, res) => {
    const { address, nonce, signature } = req.body || {};
    const n = nonces.get(String(nonce));
    if (!n || n.used || Date.now() > n.expires || !address || n.address !== String(address).toLowerCase()) {
      return res.status(401).json({ error: "AuthenticationFailed" });
    }
    let recovered;
    try {
      recovered = ethers.verifyMessage(n.message, signature).toLowerCase();
    } catch {
      return res.status(401).json({ error: "AuthenticationFailed" });
    }
    if (recovered !== n.address) return res.status(401).json({ error: "AuthenticationFailed" });
    n.used = true; // single use, and only after successful verification
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { address: recovered, expires: Date.now() + SESSION_TTL_MS });
    res.json({ token, address: recovered });
  });

  function auth(req, res, next) {
    const h = req.get("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const s = sessions.get(token);
    if (!s || Date.now() > s.expires) return res.status(401).json({ error: "authentication required" });
    req.caller = s.address;
    next();
  }

  // ------------------------------------------------------------------ device path
  // returns { att, execMs, attempts }; execMs is the witness's own handler time for the successful call
  async function fetchAttestation(rid) {
    for (let i = 0; i <= fetchRetries; i++) {
      const r = await fetch(`${witnessUrl}/attestation/${rid}`);
      if (r.status === 200) return { att: await r.json(), execMs: Number(r.headers.get("x-exec-ms")), attempts: i + 1 };
      if (r.status !== 404) throw new Error(`witness returned ${r.status}`);
      await new Promise((ok) => setTimeout(ok, fetchBackoffMs * (i + 1)));
    }
    return { att: null, execMs: NaN, attempts: fetchRetries + 1 };
  }

  app.post("/ingest", wrap(async (req, res) => {
    const t0 = P.nowMs();
    const { did, rid, record } = req.body || {};
    if (!P.isBytes32(did) || !P.isBytes32(rid) || !record || typeof record !== "object") {
      return res.status(400).json({ error: "malformed request" });
    }
    if (String(record.did).toLowerCase() !== did.toLowerCase()) return res.status(400).json({ error: "record/did mismatch" });
    const h2 = P.recordDigest(record);

    const tF = P.nowMs();
    let att, fetchExecMs, fetchAttempts;
    try {
      ({ att, execMs: fetchExecMs, attempts: fetchAttempts } = await fetchAttestation(rid.toLowerCase()));
    } catch (e) {
      return res.status(502).json({ error: "witness unavailable", detail: e.message });
    }
    const fetchMs = P.nowMs() - tF;
    if (!att) return res.status(409).json({ error: "NoAttestation" });

    const tV = P.nowMs();
    if (att.h !== h2.toLowerCase() || att.did !== did.toLowerCase()) {
      log(`[gateway] IntegrityViolation rid=${rid}`);
      return res.status(409).json({ error: "IntegrityViolation", timings: { fetchMs } });
    }
    let signer;
    try {
      signer = P.recoverAttestationSigner({ chainId, contract: contractAddress, rid: att.rid, h: att.h, did: att.did, tW: att.tW }, att.sig);
    } catch {
      signer = null;
    }
    if (!signer || signer.toLowerCase() !== witnessAddress.toLowerCase()) {
      return res.status(409).json({ error: "InvalidAttestation" });
    }
    const verifyMs = P.nowMs() - tV;

    const tC = P.nowMs();
    let receipt;
    try {
      const tx = await serialSend(() => contract.commitProof(att.rid, att.h, att.did, att.tW, att.sig));
      receipt = await tx.wait();
    } catch (e) {
      return res.status(409).json({ error: "CommitFailed", detail: e.shortMessage || e.message });
    }
    const commitMs = P.nowMs() - tC;

    const tP = P.nowMs();
    await store.put("device", att.rid, { record, digest: att.h, txHash: receipt.hash });
    const persistMs = P.nowMs() - tP;

    res.json({
      status: "Success",
      rid: att.rid,
      digest: att.h,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
      timings: { fetchMs, verifyMs, commitMs, persistMs, totalMs: P.nowMs() - t0, fetchExecMs, fetchAttempts },
    });
  }));

  app.get("/device/:rid", auth, wrap(async (req, res) => {
    const item = store.get("device", String(req.params.rid).toLowerCase());
    if (!item) return res.status(404).json({ error: "not found" });
    const pid = P.toBytes32Id(item.record.pid);
    if (!(await contract.canReadPhi(pid, req.caller))) return res.status(403).json({ error: "AccessDenied" });
    res.json(item);
  }));

  // ------------------------------------------------------------------ user records
  app.post("/phi", auth, wrap(async (req, res) => {
    const { rid, pid, record } = req.body || {};
    if (!P.isBytes32(rid) || !P.isBytes32(pid) || !record) return res.status(400).json({ error: "malformed request" });
    const onchain = await contract.phiRecords(rid);
    if (onchain.digest === ethers.ZeroHash) return res.status(409).json({ error: "digest not committed" });
    if (onchain.digest.toLowerCase() !== P.recordDigest(record) || onchain.author.toLowerCase() !== req.caller || onchain.pid.toLowerCase() !== pid.toLowerCase()) {
      return res.status(409).json({ error: "IntegrityViolation" });
    }
    await store.put("phi", rid.toLowerCase(), { pid: pid.toLowerCase(), record, digest: onchain.digest });
    res.json({ status: "Stored" });
  }));

  app.get("/phi/:rid", auth, wrap(async (req, res) => {
    const item = store.get("phi", String(req.params.rid).toLowerCase());
    if (!item) return res.status(404).json({ error: "not found" });
    if (!(await contract.canReadPhi(item.pid, req.caller))) return res.status(403).json({ error: "AccessDenied" });
    res.json(item);
  }));

  app.post("/rx", auth, wrap(async (req, res) => {
    const { rxId, pid, record } = req.body || {};
    if (!P.isBytes32(rxId) || !P.isBytes32(pid) || !record) return res.status(400).json({ error: "malformed request" });
    const onchain = await contract.prescriptions(rxId);
    if (onchain.digest === ethers.ZeroHash) return res.status(409).json({ error: "digest not committed" });
    if (onchain.digest.toLowerCase() !== P.recordDigest(record) || onchain.author.toLowerCase() !== req.caller || onchain.pid.toLowerCase() !== pid.toLowerCase()) {
      return res.status(409).json({ error: "IntegrityViolation" });
    }
    await store.put("rx", rxId.toLowerCase(), { pid: pid.toLowerCase(), record, digest: onchain.digest });
    res.json({ status: "Stored" });
  }));

  app.get("/rx/:rxId", auth, wrap(async (req, res) => {
    const id = String(req.params.rxId).toLowerCase();
    const item = store.get("rx", id);
    if (!item) return res.status(404).json({ error: "not found" });
    if (!(await contract.canReadRx(id, req.caller))) return res.status(403).json({ error: "AccessDenied" });
    res.json(item);
  }));

  // ------------------------------------------------------------------ personal records (admin)
  app.post("/personal/patient", auth, wrap(async (req, res) => {
    const { pid, record } = req.body || {};
    if (!P.isBytes32(pid) || !record) return res.status(400).json({ error: "malformed request" });
    if (req.caller !== (await contract.admin()).toLowerCase()) return res.status(403).json({ error: "AccessDenied" });
    const p = await contract.patients(pid);
    if (!p.exists || p.metaDigest.toLowerCase() !== P.recordDigest(record)) return res.status(409).json({ error: "IntegrityViolation" });
    await store.put("patients", pid.toLowerCase(), { record, digest: p.metaDigest });
    res.json({ status: "Stored" });
  }));

  app.get("/personal/patient/:pid", auth, wrap(async (req, res) => {
    const pid = String(req.params.pid).toLowerCase();
    const item = store.get("patients", pid);
    if (!item) return res.status(404).json({ error: "not found" });
    if (!(await contract.canReadPersonal(pid, req.caller))) return res.status(403).json({ error: "AccessDenied" });
    res.json(item);
  }));

  app.post("/personal/clinician", auth, wrap(async (req, res) => {
    const { address, record } = req.body || {};
    if (!ethers.isAddress(address) || !record) return res.status(400).json({ error: "malformed request" });
    if (req.caller !== (await contract.admin()).toLowerCase()) return res.status(403).json({ error: "AccessDenied" });
    const meta = await contract.clinicianMeta(address);
    if (meta.toLowerCase() !== P.recordDigest(record)) return res.status(409).json({ error: "IntegrityViolation" });
    await store.put("clinicians", address.toLowerCase(), { record, digest: meta });
    res.json({ status: "Stored" });
  }));

  app.get("/personal/clinician/:address", auth, wrap(async (req, res) => {
    const addr = String(req.params.address).toLowerCase();
    const item = store.get("clinicians", addr);
    if (!item) return res.status(404).json({ error: "not found" });
    const isAdmin = req.caller === (await contract.admin()).toLowerCase();
    if (!isAdmin && req.caller !== addr) return res.status(403).json({ error: "AccessDenied" });
    res.json(item);
  }));

  app.get("/health", (_req, res) => res.json({ ok: true, contract: contractAddress }));

  // Any unexpected error becomes a 500 response instead of terminating the gateway.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    log(`[gateway] error: ${err && err.message}`);
    res.status(500).json({ error: "InternalError", detail: err && (err.shortMessage || err.message) });
  });

  return app;
}

module.exports = { createGateway };
