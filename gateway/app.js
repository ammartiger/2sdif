"use strict";
/**
 * 2SDIF fog gateway (Express).
 *
 * Device path (POST /ingest): persist the record, sign a receipt for (rid, digest), fetch the witness
 * attestation for rid = H(did, seq), reject early if the digests differ, and submit commitProof
 * idempotently. The contract, not this gateway, is the decisive check: it only accepts witness-attested
 * digests.
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
const { connectionCount } = require("../shared/http");

const NONCE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;

function createGateway({ contract, witnessUrl, witnessAddress, chainId, store, domain = "localhost", fetchRetries = 5, fetchBackoffMs = 40, log = () => {}, receiptSigner, fault = {} }) {
  receiptSigner = receiptSigner || contract.runner;
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
      await r.arrayBuffer();
      if (r.status !== 404) throw new Error(`witness returned ${r.status}`);
      await new Promise((ok) => setTimeout(ok, fetchBackoffMs * (i + 1)));
    }
    return { att: null, execMs: NaN, attempts: fetchRetries + 1 };
  }

  // Commit idempotently: if the proof is already on chain with the same digest (for example because a
  // third party front-ran our transaction with the same attestation), that is success, not failure.
  async function commitIdempotent(att) {
    try {
      let sentAt = 0;
      const tx = await serialSend(async () => {
        const t = await contract.commitProof(att.did, att.seq, att.h, att.tW, att.sig);
        sentAt = Date.now(); // wall-clock time at which the RPC node accepted the transaction
        return t;
      });
      const rc = await tx.wait();
      return { txHash: rc.hash, gasUsed: rc.gasUsed.toString(), blockNumber: rc.blockNumber, sentAt, doneAt: Date.now(), by: "gateway" };
    } catch (e) {
      const onchain = await contract.getProof(att.rid);
      if (onchain.toLowerCase() === att.h) return { txHash: null, gasUsed: null, blockNumber: null, sentAt: null, doneAt: null, by: "other" };
      throw e;
    }
  }

  let ingestCount = 0;

  app.post("/ingest", wrap(async (req, res) => {
    const t0 = P.nowMs();
    const { did, seq, record } = req.body || {};
    let seqN;
    try { seqN = BigInt(seq); } catch { seqN = -1n; }
    if (!P.isBytes32(did) || seqN < 0n || !record || typeof record !== "object") {
      return res.status(400).json({ error: "malformed request" });
    }
    if (String(record.did).toLowerCase() !== did.toLowerCase() || String(record.seq) !== seqN.toString()) {
      return res.status(400).json({ error: "record/identifier mismatch" });
    }
    const rid = P.recordId(did, seqN);
    const h2 = P.recordDigest(record);

    // Persist before committing, so that a proof on chain always has its record here; then sign a receipt
    // that lets the device show later that this gateway accepted (rid, h2).
    const tP0 = P.nowMs();
    await store.put("device", rid, { record, digest: h2, status: "pending", receivedAt: Date.now() });
    let persistMs = P.nowMs() - tP0;
    const receipt = await P.signReceipt(receiptSigner, { chainId, contract: contractAddress, rid, h: h2 });

    const tF = P.nowMs();
    const c0 = connectionCount();
    let att, fetchExecMs, fetchAttempts;
    try {
      ({ att, execMs: fetchExecMs, attempts: fetchAttempts } = await fetchAttestation(rid));
    } catch (e) {
      return res.status(502).json({ error: "witness unavailable", detail: e.message, rid, receipt });
    }
    const fetchMs = P.nowMs() - tF;
    const fetchConns = connectionCount() - c0;
    if (!att) return res.status(409).json({ error: "NoAttestation", rid, receipt });

    const tV = P.nowMs();
    if (att.h !== h2.toLowerCase() || att.did !== did.toLowerCase() || String(att.seq) !== seqN.toString() || att.rid !== rid) {
      log(`[gateway] IntegrityViolation rid=${rid}`);
      // keep the received record and both digests as evidence for the audit
      await store.put("device", rid, { record, digest: h2, attested: att.h, status: "rejected", receivedAt: Date.now() });
      return res.status(409).json({ error: "IntegrityViolation", rid, timings: { fetchMs } });
    }
    let signer;
    try {
      signer = P.recoverAttestationSigner({ chainId, contract: contractAddress, did: att.did, seq: att.seq, h: att.h, tW: att.tW }, att.sig);
    } catch {
      signer = null;
    }
    if (!signer || signer.toLowerCase() !== witnessAddress.toLowerCase()) {
      return res.status(409).json({ error: "InvalidAttestation", rid });
    }
    const verifyMs = P.nowMs() - tV;

    // Faulty-gateway behaviour for the omission experiments only (never enabled in normal operation).
    ingestCount += 1;
    if (fault.withholdEvery && ingestCount % fault.withholdEvery === 0) {
      log(`[gateway] FAULT withholding rid=${rid}`);
      return res.status(202).json({ status: "Accepted", rid, digest: h2, receipt, fault: "withheld" });
    }
    if (fault.delayEvery && ingestCount % fault.delayEvery === 0) {
      log(`[gateway] FAULT delaying rid=${rid} by ${fault.delayMs} ms`);
      setTimeout(() => {
        commitIdempotent(att)
          .then((c) => store.put("device", rid, { record, digest: h2, status: "committed", txHash: c.txHash, receivedAt: Date.now() }))
          .catch((e) => log(`[gateway] delayed commit failed rid=${rid}: ${e.message}`));
      }, fault.delayMs);
      return res.status(202).json({ status: "Accepted", rid, digest: h2, receipt, fault: "delayed" });
    }

    const tC = P.nowMs();
    let c;
    try {
      c = await commitIdempotent(att);
    } catch (e) {
      return res.status(409).json({ error: "CommitFailed", detail: e.shortMessage || e.message, rid, receipt });
    }
    const commitMs = P.nowMs() - tC;

    const tP = P.nowMs();
    await store.put("device", rid, { record, digest: h2, status: "committed", txHash: c.txHash, receivedAt: Date.now() });
    persistMs += P.nowMs() - tP;

    res.json({
      status: "Success",
      rid,
      digest: h2,
      txHash: c.txHash,
      committedBy: c.by,
      gasUsed: c.gasUsed,
      blockNumber: c.blockNumber,
      commitSentAt: c.sentAt,
      commitDoneAt: c.doneAt,
      receipt,
      timings: { fetchMs, verifyMs, commitMs, persistMs, totalMs: P.nowMs() - t0, fetchExecMs, fetchAttempts, fetchConns },
    });
  }));

  app.get("/device/:rid", auth, wrap(async (req, res) => {
    const item = store.get("device", String(req.params.rid).toLowerCase());
    if (!item || item.status !== "committed") return res.status(404).json({ error: "not found" });
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
