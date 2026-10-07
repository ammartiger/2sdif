"use strict";
/**
 * IoT device (simulated bedside sensor). Holds a device id and an HMAC key shared only with the witness.
 * submit(): channel 2 = tagged digest to the witness, channel 1 = record to the fog gateway.
 */
const P = require("../shared/protocol");

const DEFAULT_RECORD_BYTES = Number(process.env.RECORD_BYTES || 320);

class Device {
  constructor({ label, did, key, pid }) {
    this.label = label;
    this.did = P.toBytes32Id(did || label);
    this.key = key.replace(/^0x/, "");
    this.pid = P.toBytes32Id(pid);
  }

  /** A synthetic vital-signs reading padded to a fixed canonical size (default 320 bytes). */
  makeReading(targetBytes = DEFAULT_RECORD_BYTES) {
    const rec = {
      did: this.did,
      pid: this.pid,
      type: "vital_signs",
      hr: 60 + Math.floor(Math.random() * 40),
      spo2: 94 + Math.floor(Math.random() * 6),
      tempC: Math.round((36 + Math.random() * 1.5) * 10) / 10,
      ts: Date.now(),
      nonce: P.randomNonceHex(16),
      pad: "",
    };
    const len = Buffer.byteLength(P.canonicalize(rec), "utf8");
    if (len < targetBytes) rec.pad = "x".repeat(targetBytes - len);
    return rec;
  }

  /** Digest + HMAC tag for a record (the device-side cryptographic work). */
  prepare(record, rid = P.randomBytes32(), t = Math.floor(Date.now() / 1000)) {
    const h = P.recordDigest(record);
    const tag = P.deviceTag(this.key, { did: this.did, rid, h, t });
    return { deposit: { did: this.did, rid, h, t, tag }, ingest: { did: this.did, rid, record } };
  }

  /** Full submission; returns timings (ms) and the gateway response. */
  async submit(record, { witnessUrl, gatewayUrl }) {
    const { deposit, ingest } = this.prepare(record);
    const t0 = P.nowMs();
    const dr = await fetch(`${witnessUrl}/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(deposit) });
    const depositBody = await dr.json();
    const depositMs = P.nowMs() - t0;
    const depositExecMs = Number(dr.headers.get("x-exec-ms"));
    if (dr.status !== 201) return { ok: false, stage: "deposit", status: dr.status, body: depositBody, depositMs };
    const t1 = P.nowMs();
    const gr = await fetch(`${gatewayUrl}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ingest) });
    const gwBody = await gr.json();
    const gatewayRoundTripMs = P.nowMs() - t1;
    const e2eMs = P.nowMs() - t0;
    const ok = gr.status === 200;
    const tm = gwBody.timings || {};
    return {
      ok,
      stage: ok ? "done" : "gateway",
      status: gr.status,
      body: gwBody,
      rid: deposit.rid,
      depositMs,
      transferMs: ok ? gatewayRoundTripMs - tm.totalMs : undefined,
      fetchMs: tm.fetchMs,
      verifyMs: tm.verifyMs,
      commitMs: tm.commitMs,
      persistMs: tm.persistMs,
      e2eMs,
      gasUsed: gwBody.gasUsed,
      depositExecMs,
      fetchExecMs: tm.fetchExecMs,
      fetchAttempts: tm.fetchAttempts,
    };
  }
}

module.exports = { Device, DEFAULT_RECORD_BYTES };
