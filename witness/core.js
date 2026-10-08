"use strict";
/**
 * Witness core logic (platform independent). Used by the Azure Functions app and by the
 * local emulator. The witness:
 *   1. checks that the deposit is meant for its own deployment (dep = H(chainId, contract)),
 *   2. verifies the device HMAC tag under the device key it shares with the device,
 *   3. rejects stale deposits (clock skew window) and duplicates (write once per record id,
 *      where rid = H(did, seq) is derived from the authenticated device identifier),
 *   4. signs an attestation that binds (chainId, contract, did, seq, h, tW),
 *   5. serves attestations to gateways and its log to an authenticated auditor.
 * It never sees record contents, only digests.
 */
const P = require("../shared/protocol");

const MAX_SEQ = (1n << 64n) - 1n;

class Witness {
  /**
   * @param {object} o
   * @param {import('ethers').Wallet} o.signer    witness signing key
   * @param {Map<string,string>} o.deviceKeys     did (bytes32 hex, lower case) -> key hex
   * @param {object} o.store                     { insertOnce(entity) -> bool, get(rid), list(sinceSec) }
   * @param {number|bigint} o.chainId
   * @param {string} o.contract                  TwoSDIFRegistry address
   * @param {number} [o.maxSkewSec=300]
   */
  constructor({ signer, deviceKeys, store, chainId, contract, maxSkewSec = 300, nowSec }) {
    this.signer = signer;
    this.deviceKeys = deviceKeys;
    this.store = store;
    this.chainId = chainId;
    this.contract = contract;
    this.dep = P.deploymentId(chainId || 0, contract || "0x0000000000000000000000000000000000000000");
    this.maxSkewSec = maxSkewSec;
    this.nowSec = nowSec || (() => Math.floor(Date.now() / 1000));
  }

  get address() {
    return this.signer.address;
  }

  /** Handle a device deposit. Returns { status, body }. */
  async deposit(input) {
    const { did, seq, h, t, dep, tag } = input || {};
    let seqN;
    try {
      seqN = BigInt(seq);
    } catch {
      seqN = -1n;
    }
    if (!P.isBytes32(did) || !P.isBytes32(h) || !P.isBytes32(dep) || seqN < 0n || seqN > MAX_SEQ || !Number.isFinite(Number(t))) {
      return { status: 400, body: { error: "malformed deposit" } };
    }
    if (dep.toLowerCase() !== this.dep) return { status: 400, body: { error: "deposit for another deployment" } };
    const key = this.deviceKeys.get(did.toLowerCase());
    if (!key || !P.verifyDeviceTag(key, { did, seq: seqN, h, t, dep }, tag)) {
      return { status: 401, body: { error: "invalid device tag" } };
    }
    const now = this.nowSec();
    if (Math.abs(now - Number(t)) > this.maxSkewSec) {
      return { status: 401, body: { error: "stale deposit" } };
    }
    const fields = { chainId: this.chainId, contract: this.contract, did: did.toLowerCase(), seq: seqN, h: h.toLowerCase(), tW: now };
    const sig = await P.signAttestation(this.signer, fields);
    const entity = { rid: P.recordId(fields.did, seqN), did: fields.did, seq: seqN.toString(), h: fields.h, tW: now, sig, dep: this.dep };
    // the conditional insert is the write-once point: a second deposit for the same (did, seq) is refused
    const inserted = await this.store.insertOnce(entity);
    if (!inserted) return { status: 409, body: { error: "duplicate record id" } };
    return { status: 201, body: entity };
  }

  async attestation(rid) {
    if (!P.isBytes32(rid)) return { status: 400, body: { error: "malformed rid" } };
    const e = await this.store.get(rid.toLowerCase());
    // entries attested under an earlier binding (another chain or contract) are not served
    if (!e || e.dep !== this.dep) return { status: 404, body: { error: "not found" } };
    return { status: 200, body: e };
  }

  async log(sinceSec = 0) {
    // the log is scoped to the current deployment
    const entries = (await this.store.list(Number(sinceSec) || 0)).filter((e) => e.dep === this.dep);
    return { status: 200, body: { witness: this.address, chainId: String(this.chainId), contract: this.contract, dep: this.dep, entries } };
  }
}

/** Simple in-memory store with write-once semantics (local emulator and tests). */
class MemoryStore {
  constructor() {
    this.map = new Map();
  }
  async insertOnce(entity) {
    if (this.map.has(entity.rid)) return false;
    this.map.set(entity.rid, { ...entity });
    return true;
  }
  async get(rid) {
    const e = this.map.get(rid);
    return e ? { ...e } : null;
  }
  async list(sinceSec) {
    return [...this.map.values()].filter((e) => e.tW >= sinceSec).map((e) => ({ ...e }));
  }
}

function parseDeviceKeys(json) {
  const obj = typeof json === "string" ? JSON.parse(json) : json;
  const m = new Map();
  for (const [did, key] of Object.entries(obj || {})) m.set(P.toBytes32Id(did), key.replace(/^0x/, ""));
  return m;
}

module.exports = { Witness, MemoryStore, parseDeviceKeys };
