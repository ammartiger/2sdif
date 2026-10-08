"use strict";
/**
 * IoT device (simulated bedside sensor). Holds a device id and an HMAC key shared only with the witness,
 * and a monotonic sequence number; its record identifiers are rid = H(did, seq).
 * submit(): channel 2 = tagged digest to the witness, channel 1 = record to the fog gateway.
 * The device keeps the gateway's signed receipt, which attributes a later omission to the gateway.
 */
const P = require("../shared/protocol");
const { connectionCount } = require("../shared/http");

const DEFAULT_RECORD_BYTES = Number(process.env.RECORD_BYTES || 320);

class Device {
  /**
   * @param {object} o
   * @param {string} o.label
   * @param {string} [o.did]       bytes32 or label
   * @param {string} o.key         HMAC key (hex)
   * @param {string} o.pid         patient identifier (bytes32 or label)
   * @param {string} [o.dep]       deployment id H(chainId, contract) the device reports to
   * @param {bigint|number} [o.seqStart]  first sequence number (default: milliseconds since the epoch
   *                                       times 10^6, which keeps runs of a simulated device from colliding;
   *                                       load tests add 1000 * session index for concurrent sessions)
   */
  constructor({ label, did, key, pid, dep, seqStart }) {
    this.label = label;
    this.did = P.toBytes32Id(did || label);
    this.key = key.replace(/^0x/, "");
    this.pid = P.toBytes32Id(pid);
    this.dep = dep ? dep.toLowerCase() : null;
    this.seq = BigInt(seqStart ?? BigInt(Date.now()) * 1000000n);
    this.receipts = [];
  }

  nextSeq() {
    const s = this.seq;
    this.seq += 1n;
    return s;
  }

  /** A synthetic vital-signs reading padded to a fixed canonical size (default 320 bytes). */
  makeReading(targetBytes = DEFAULT_RECORD_BYTES) {
    const rec = {
      did: this.did,
      seq: this.nextSeq().toString(),
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
  prepare(record, t = Math.floor(Date.now() / 1000)) {
    if (!this.dep) throw new Error("device has no deployment id (dep)");
    const seq = BigInt(record.seq);
    const h = P.recordDigest(record);
    const tag = P.deviceTag(this.key, { did: this.did, seq, h, t, dep: this.dep });
    return {
      rid: P.recordId(this.did, seq),
      deposit: { did: this.did, seq: seq.toString(), h, t, dep: this.dep, tag },
      ingest: { did: this.did, seq: seq.toString(), record },
    };
  }

  /** Omission experiment only: the deposit is lost (channel 2 suppressed); the record still goes to the gateway. */
  async submitWithoutDeposit(record, { gatewayUrl }) {
    const { rid, deposit, ingest } = this.prepare(record);
    const gr = await fetch(`${gatewayUrl}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ingest) });
    const body = await gr.json();
    if (body.receipt) this.receipts.push({ rid, h: deposit.h, receipt: body.receipt });
    return { ok: false, stage: "suppressed", status: gr.status, body, rid, seq: deposit.seq };
  }

  /** Full submission; returns timings (ms), new connections opened, and the gateway response. */
  async submit(record, { witnessUrl, gatewayUrl }) {
    const { rid, deposit, ingest } = this.prepare(record);
    const c0 = connectionCount();
    const t0 = P.nowMs();
    const dr = await fetch(`${witnessUrl}/deposit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(deposit) });
    const depositBody = await dr.json();
    const depositMs = P.nowMs() - t0;
    const depositExecMs = Number(dr.headers.get("x-exec-ms"));
    const depositConns = connectionCount() - c0;
    if (dr.status !== 201) return { ok: false, stage: "deposit", status: dr.status, body: depositBody, depositMs, rid };
    const t1 = P.nowMs();
    const gr = await fetch(`${gatewayUrl}/ingest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ingest) });
    const gwBody = await gr.json();
    const gatewayRoundTripMs = P.nowMs() - t1;
    const e2eMs = P.nowMs() - t0;
    const ok = gr.status === 200;
    if (gwBody.receipt) this.receipts.push({ rid, h: deposit.h, receipt: gwBody.receipt });
    const tm = gwBody.timings || {};
    return {
      ok,
      stage: ok ? "done" : "gateway",
      status: gr.status,
      body: gwBody,
      rid,
      seq: deposit.seq,
      depositMs,
      tW: depositBody.tW,
      transferMs: ok ? gatewayRoundTripMs - tm.totalMs : undefined,
      fetchMs: tm.fetchMs,
      verifyMs: tm.verifyMs,
      commitMs: tm.commitMs,
      persistMs: tm.persistMs,
      e2eMs,
      gasUsed: gwBody.gasUsed,
      txHash: gwBody.txHash,
      depositExecMs,
      fetchExecMs: tm.fetchExecMs,
      fetchAttempts: tm.fetchAttempts,
      depositConns,
      receipt: gwBody.receipt,
    };
  }
}

module.exports = { Device, DEFAULT_RECORD_BYTES };
