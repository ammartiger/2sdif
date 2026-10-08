/* 2SDIF web client: users sign their own transactions; every record read is verified against the chain. */
"use strict";
let cfg, provider, signer, me, contract, token;

const $ = (id) => document.getElementById(id);
function log(msg, cls) {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  $("log").prepend(line);
}

// --- canonical JSON + SHA-256 (must match shared/protocol.js) ---------------------------
function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  return "{" + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}
async function recordDigest(rec) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalize(rec)));
  return "0x" + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomId = () => ethers.hexlify(ethers.randomBytes(32));
const nonce = () => ethers.hexlify(ethers.randomBytes(16)).slice(2);
const pidOf = (nid) => ethers.keccak256(ethers.toUtf8Bytes(`${cfg.pidSalt}:${nid}`));

async function api(method, path, body) {
  const r = await fetch(cfg.gatewayUrl + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${data.error || ""}`);
  return data;
}

async function send(txPromise, what) {
  const tx = await txPromise;
  log(`${what}: sent ${tx.hash}`);
  const rc = await tx.wait();
  log(`${what}: included in block ${rc.blockNumber}, gas ${rc.gasUsed}`, "ok");
  return rc;
}

async function connect() {
  cfg = await (await fetch("config.json")).json();
  if (!window.ethereum) throw new Error("MetaMask not found");
  provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  signer = await provider.getSigner();
  me = await signer.getAddress();
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(cfg.chainId)) log(`MetaMask is on chain ${net.chainId}, deployment is on ${cfg.chainId}`, "bad");
  contract = new ethers.Contract(cfg.contract, cfg.abi, signer);
  const n = await api("GET", `/auth/nonce?address=${me}`);
  const signature = await signer.signMessage(n.message);
  token = (await api("POST", "/auth/login", { address: me, nonce: n.nonce, signature })).token;
  $("who").textContent = `signed in as ${me.slice(0, 8)}…`;
  log(`signed in as ${me}`, "ok");
}

const actions = {
  async registerClinician() {
    const record = { address: $("clinAddr").value.trim(), name: $("clinName").value, phone: $("clinPhone").value, nationalId: $("clinNid").value, nonce: nonce() };
    await send(contract.registerClinician(record.address, await recordDigest(record)), "registerClinician");
    await api("POST", "/personal/clinician", { address: record.address, record });
    log("clinician record stored at the fog", "ok");
  },
  async registerPatient() {
    const pid = pidOf($("patNid").value);
    const record = { nationalId: $("patNid").value, name: $("patName").value, contact: $("patContact").value, nonce: nonce() };
    await send(contract.registerPatient(pid, $("patAddr").value.trim(), $("patClin").value.trim(), await recordDigest(record)), "registerPatient");
    await api("POST", "/personal/patient", { pid, record });
    log(`patient ${pid} stored at the fog`, "ok");
  },
  async addPhi() {
    const pid = pidOf($("phiNid").value);
    const rid = randomId();
    const record = { pid, diseases: $("phiDx").value, healthPlan: $("phiPlan").value, payment: $("phiPay").value, nonce: nonce() };
    await send(contract.addPhiRecord(rid, pid, await recordDigest(record)), "addPhiRecord");
    await api("POST", "/phi", { rid, pid, record });
    $("readId").value = rid;
    log(`health information ${rid} stored`, "ok");
  },
  async grantPhi() { await send(contract.grantPhiAccess(pidOf($("phiNid").value), $("phiReader").value.trim()), "grantPhiAccess"); },
  async revokePhi() { await send(contract.revokePhiAccess(pidOf($("phiNid").value), $("phiReader").value.trim()), "revokePhiAccess"); },
  async addRx() {
    const pid = pidOf($("rxNid").value);
    const rxId = randomId();
    const record = { pid, disease: $("rxDx").value, prescription: $("rxText").value, doctor: me, nonce: nonce() };
    await send(contract.addPrescription(rxId, pid, await recordDigest(record)), "addPrescription");
    await api("POST", "/rx", { rxId, pid, record });
    $("rxId").value = rxId;
    $("readId").value = rxId;
    log(`prescription ${rxId} stored`, "ok");
  },
  async grantRx() { await send(contract.grantRxAccess($("rxId").value.trim(), $("rxReader").value.trim()), "grantRxAccess"); },
  async revokeRx() { await send(contract.revokeRxAccess($("rxId").value.trim(), $("rxReader").value.trim()), "revokeRxAccess"); },
  async readPhi() { await readAndVerify("/phi/", async (id) => (await contract.phiRecords(id)).digest); },
  async readRx() { await readAndVerify("/rx/", async (id) => (await contract.prescriptions(id)).digest); },
  // device records: the digest must match AND the record must carry the (did, seq) its id is derived from
  async readDevice() {
    await readAndVerify("/device/", async (id) => contract.getProof(id), (id, rec) =>
      ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint64"], [rec.did, BigInt(rec.seq)])).toLowerCase() === id.toLowerCase());
  },
};

async function readAndVerify(path, onchainDigest, idCheck = () => true) {
  const id = $("readId").value.trim();
  const item = await api("GET", path + id);
  const local = await recordDigest(item.record);
  const chain = await onchainDigest(id);
  const ok = local.toLowerCase() === chain.toLowerCase() && idCheck(id, item.record);
  $("verdict").innerHTML = `<b class="${ok ? "ok" : "bad"}">${ok ? "Verified against the chain" : "NOT verified: digest mismatch"}</b><br><code>${canonicalize(item.record)}</code>`;
  log(`read ${id}: ${ok ? "verified" : "digest mismatch"}`, ok ? "ok" : "bad");
}

$("btnConnect").onclick = () => connect().catch((e) => log(e.message, "bad"));
document.querySelectorAll("button[data-action]").forEach((b) => {
  b.onclick = async () => {
    if (!token) return log("connect and sign in first", "bad");
    try { await actions[b.dataset.action](); } catch (e) { log(e.shortMessage || e.message, "bad"); }
  };
});
