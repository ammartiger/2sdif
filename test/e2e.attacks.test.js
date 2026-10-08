/**
 * End-to-end attack suite (paper, Table "Attack suite").
 * Runs the real witness app, gateway app and device code against the Hardhat network.
 * Each scenario is a conformance test with a defined oracle; T1-T4 and T6-T8 repeat ATTACK_RUNS times
 * (default 20) with fresh records, T5 is one run over 60 records. Writes results/attacks_<mode>.csv.
 *
 * Remote mode (ATTACK_WITNESS_URL set, run with --network localhost): the scenarios run against a deployed
 * witness (e.g. the Azure Functions app) bound to the contract in deployments/localhost.json, using the first
 * device in devices.json and AUDITOR_KEY as the log key; writes results/attacks_remote.csv.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const P = require("../shared/protocol");
const { Witness, MemoryStore, parseDeviceKeys } = require("../witness/core");
const { createWitnessApp } = require("../witness/app");
const { createGateway } = require("../gateway/app");
const { JsonStore } = require("../gateway/store");
const { Device } = require("../device/device");
const { auditEntries, committedProofs } = require("../auditor/audit");

const RUNS = Number(process.env.ATTACK_RUNS || 20);
const REMOTE = process.env.ATTACK_WITNESS_URL ? process.env.ATTACK_WITNESS_URL.replace(/\/$/, "") : null;
const results = [];
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function listen(app) {
  return new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

describe("End-to-end attack suite", function () {
  this.timeout(REMOTE ? 0 : 300000);
  let c, admin, clin, clin2, doc, patient, outsider, gwSigner, witnessAddress, witnessSrv, gatewaySrv, faultySrv;
  let dev, dev2, urls, chainId, contractAddress, dep, pid, auditorKey;

  async function ensureClinician(addr, tag) {
    if (!(await c.isClinician(addr))) await (await c.registerClinician(addr, P.recordDigest({ n: tag }))).wait();
  }
  const gatewayFor = (url, fault = {}) =>
    createGateway({
      contract: c.connect(gwSigner),
      witnessUrl: url,
      witnessAddress,
      chainId,
      store: new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), "2sdif-"))),
      receiptSigner: gwSigner,
      fault,
    });

  before(async function () {
    [admin, clin, clin2, doc, patient, outsider, gwSigner] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    // in remote mode a fresh patient per run (the deployment is shared with the benchmarks)
    pid = P.toBytes32Id(REMOTE ? `attack-patient-${Date.now()}` : "patient-01");
    let witnessUrl;
    if (REMOTE) {
      const depFile = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
      const health = await (await fetch(`${REMOTE}/health`)).json();
      if (health.contract.toLowerCase() !== depFile.address.toLowerCase() || health.chainId !== String(chainId)) {
        throw new Error(`remote witness is bound to ${health.contract} on chain ${health.chainId}, not ${depFile.address} on ${chainId}`);
      }
      witnessAddress = health.witness;
      c = (await ethers.getContractAt("TwoSDIFRegistry", depFile.address)).connect(admin);
      const devices = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || path.join(__dirname, "..", "devices.json"), "utf8")).devices;
      contractAddress = depFile.address;
      dep = P.deploymentId(chainId, contractAddress);
      dev = new Device({ label: devices[0].label, key: devices[0].key, pid, dep });
      dev2 = new Device({ label: devices[1].label, key: devices[1].key, pid: "patient-02", dep });
      auditorKey = process.env.AUDITOR_KEY;
      witnessUrl = REMOTE;
    } else {
      const witnessWallet = ethers.Wallet.createRandom();
      witnessAddress = witnessWallet.address;
      c = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witnessAddress, 3600);
      contractAddress = await c.getAddress();
      dep = P.deploymentId(chainId, contractAddress);
      const key = crypto.randomBytes(32).toString("hex"), key2 = crypto.randomBytes(32).toString("hex");
      dev = new Device({ label: "sensor-01", key, pid: "patient-01", dep });
      dev2 = new Device({ label: "sensor-02", key: key2, pid: "patient-02", dep });
      auditorKey = crypto.randomBytes(16).toString("hex");
      const core = new Witness({ signer: witnessWallet, deviceKeys: parseDeviceKeys({ [dev.did]: key, [dev2.did]: key2 }), store: new MemoryStore(), chainId, contract: contractAddress });
      witnessSrv = await listen(createWitnessApp(core, { auditorKey }));
      witnessUrl = `${witnessSrv.url}/api`;
    }
    await ensureClinician(clin.address, "clin");
    await ensureClinician(clin2.address, "clin2");
    await ensureClinician(doc.address, "doc");
    await (await c.registerPatient(pid, patient.address, clin.address, P.recordDigest({ n: "p" }))).wait();
    gatewaySrv = await listen(gatewayFor(witnessUrl));
    urls = { witnessUrl, gatewayUrl: gatewaySrv.url };
  });

  after(function () {
    for (const s of [witnessSrv, gatewaySrv, faultySrv]) if (s) s.server.close();
    const dir = path.join(__dirname, "..", "results");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `attacks_${REMOTE ? "remote" : network.name}.csv`);
    fs.writeFileSync(file, ["id,scenario,runs,stopped", ...results.map((r) => `${r.id},"${r.scenario}",${r.runs},${r.stopped}`)].join("\n") + "\n");
  });

  async function post(url, body, headers = {}) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  const getAtt = async (rid) => (await fetch(`${urls.witnessUrl}/attestation/${rid}`)).json();
  const commitAtt = (att, over = {}, sig = att.sig, from = gwSigner) => c.connect(from).commitProof(over.did ?? att.did, over.seq ?? att.seq, over.h ?? att.h, att.tW, sig);
  const reverts = async (p) => { try { await (await p).wait(); return false; } catch { return true; } };

  async function login(signer) {
    const n = await (await fetch(`${urls.gatewayUrl}/auth/nonce?address=${signer.address}`)).json();
    const signature = await signer.signMessage(n.message);
    const r = await post(`${urls.gatewayUrl}/auth/login`, { address: signer.address, nonce: n.nonce, signature });
    return { ...r, nonce: n.nonce, signature };
  }

  it("honest path commits a device record and returns a verifiable gateway receipt (sanity)", async function () {
    const r = await dev.submit(dev.makeReading(), urls);
    expect(r.ok, JSON.stringify(r.body)).to.equal(true);
    expect(await c.getProof(r.rid)).to.equal(r.body.digest);
    const signer = P.recoverReceiptSigner({ chainId, contract: contractAddress, rid: r.rid, h: r.body.digest }, r.receipt);
    expect(signer).to.equal(gwSigner.address);
  });

  it("T1: tampering with the record on channel 1 is rejected", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const { deposit, ingest } = dev.prepare(dev.makeReading());
      expect((await post(`${urls.witnessUrl}/deposit`, deposit)).status).to.equal(201);
      const tampered = { ...ingest, record: { ...ingest.record, hr: ingest.record.hr + 30 } };
      const g = await post(`${urls.gatewayUrl}/ingest`, tampered);
      const att = await getAtt(P.recordId(deposit.did, deposit.seq));
      const forcedReverted = await reverts(commitAtt(att, { h: P.recordDigest(tampered.record) }));
      if (g.status === 409 && g.body.error === "IntegrityViolation" && forcedReverted) stopped++;
    }
    results.push({ id: "T1", scenario: "Member node modifies the record on channel 1", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T2: a deposit without the device key, or for another deployment, is rejected by the witness", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const rogue = new Device({ label: dev.label, key: crypto.randomBytes(32).toString("hex"), pid: "patient-01", dep });
      const r1 = await post(`${urls.witnessUrl}/deposit`, rogue.prepare(rogue.makeReading()).deposit);
      const { deposit: good } = dev.prepare(dev.makeReading());
      const r2 = await post(`${urls.witnessUrl}/deposit`, { ...good, h: P.recordDigest({ forged: i }) }); // valid tag, other digest
      const other = new Device({ label: dev.label, key: dev.key, pid: "patient-01", dep: P.deploymentId(chainId + 1n, contractAddress) });
      const r3 = await post(`${urls.witnessUrl}/deposit`, other.prepare(other.makeReading()).deposit); // valid device, wrong deployment
      if (r1.status === 401 && r2.status === 401 && r3.status === 400) stopped++;
    }
    results.push({ id: "T2", scenario: "Deposit without the device key, with a reused tag, or for another deployment", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T3: a compromised gateway cannot commit an altered, moved or self-attested digest", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const { deposit } = dev.prepare(dev.makeReading());
      await post(`${urls.witnessUrl}/deposit`, deposit);
      const att = await getAtt(P.recordId(deposit.did, deposit.seq));
      const altered = P.recordDigest({ altered: i });
      const a = await reverts(commitAtt(att, { h: altered }));
      const self = await P.signAttestation(gwSigner, { chainId, contract: contractAddress, did: att.did, seq: att.seq, h: altered, tW: att.tW });
      const b = await reverts(commitAtt(att, { h: altered }, self));
      const m = await reverts(commitAtt(att, { did: dev2.did }));
      const s = await reverts(commitAtt(att, { seq: BigInt(att.seq) + 1n }));
      if (a && b && m && s) stopped++;
    }
    results.push({ id: "T3", scenario: "Gateway commits an altered, moved or self-attested digest", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T4: replayed deposits, commitments and cross-deployment attestations are rejected", async function () {
    const c2 = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witnessAddress, 3600);
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const rec = dev.makeReading();
      const prepared = dev.prepare(rec);
      const r = await dev.submit(rec, urls);
      const reDeposit = await post(`${urls.witnessUrl}/deposit`, prepared.deposit); // captured deposit replayed
      const att = await getAtt(r.rid);
      const reCommit = await reverts(commitAtt(att));
      let cross = false;
      try { await (await c2.connect(gwSigner).commitProof(att.did, att.seq, att.h, att.tW, att.sig)).wait(); } catch { cross = true; }
      if (r.ok && reDeposit.status === 409 && reCommit && cross) stopped++;
    }
    results.push({ id: "T4", scenario: "Replay a captured deposit, a commitment, or an attestation on another deployment", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T5: withheld, late and suppressed records are flagged by the auditor; receipts attribute them", async function () {
    // Remote mode compares the witness's clock (tW) with this machine's chain clock, so it allows SKEW seconds
    // of clock offset and delays commits by more than DELTA + SKEW (plus margin for the offset itself).
    const SKEW = REMOTE ? 5 : 0;
    const TOTAL = 60, WITHHOLD_EVERY = 6, DELAY_EVERY = 10, DELAY_MS = REMOTE ? 20000 : 4000, DELTA = 2;
    faultySrv = await listen(gatewayFor(urls.witnessUrl, { withholdEvery: WITHHOLD_EVERY, delayEvery: DELAY_EVERY, delayMs: DELAY_MS }));
    const fUrls = { witnessUrl: urls.witnessUrl, gatewayUrl: faultySrv.url };
    const fromBlock = await ethers.provider.getBlockNumber();
    const since = Math.floor(Date.now() / 1000) - (REMOTE ? 300 : 1);
    const withheld = new Set(), delayed = new Set(), receipts = new Map();
    const runRids = new Set();
    let suppressed = 0;
    for (let i = 1; i <= TOTAL; i++) {
      if (i === 25) { dev.nextSeq(); suppressed++; } // the device's deposit for this sequence number never reaches the witness
      const r = await dev.submit(dev.makeReading(), fUrls);
      runRids.add(r.rid);
      if (r.body.fault === "withheld") withheld.add(r.rid);
      if (r.body.fault === "delayed") delayed.add(r.rid);
      if (r.receipt) receipts.set(r.rid, { h: r.body.digest, receipt: r.receipt });
    }
    await sleep(DELAY_MS + (DELTA + SKEW + 2) * 1000); // let delayed commits land and every bound pass, in real time
    const log = await (await fetch(`${urls.witnessUrl}/log?since=${since}`, { headers: { "x-auditor-key": auditorKey, "x-functions-key": auditorKey } })).json();
    const entries = log.entries.filter((e) => runRids.has(e.rid));
    const committed = await committedProofs(c, fromBlock);
    const report = auditEntries({ entries, committed, nowSec: Math.floor(Date.now() / 1000), deltaSec: DELTA, skewSec: SKEW, witness: witnessAddress, chainId, contract: contractAddress });
    const flaggedWithheld = report.omitted.filter((rid) => withheld.has(rid)).length;
    const flaggedLate = report.late.filter((x) => delayed.has(x.rid)).length;
    const falsePositives = report.omitted.filter((rid) => !withheld.has(rid)).length + report.late.filter((x) => !delayed.has(x.rid)).length;
    const attributed = [...withheld].filter((rid) => {
      const x = receipts.get(rid);
      return x && P.recoverReceiptSigner({ chainId, contract: contractAddress, rid, h: x.h }, x.receipt) === gwSigner.address;
    }).length;
    const gapsFound = report.gaps.filter((g) => g.did === dev.did).length;
    results.push({
      id: "T5",
      scenario: `Gateway withholds ${withheld.size} and delays ${delayed.size} of ${TOTAL} records; ${suppressed} deposit suppressed (flagged ${flaggedWithheld} omitted, ${flaggedLate} late, ${gapsFound} gap, false positives ${falsePositives}, attributed by receipt ${attributed})`,
      runs: 1,
      stopped: flaggedWithheld === withheld.size && flaggedLate === delayed.size && gapsFound === suppressed && falsePositives === 0 && attributed === withheld.size ? 1 : 0,
    });
    expect(report.invalid.length).to.equal(0);
    expect(flaggedWithheld).to.equal(withheld.size);
    expect(flaggedLate).to.equal(delayed.size);
    expect(gapsFound).to.equal(suppressed);
    expect(falsePositives).to.equal(0);
    expect(attributed).to.equal(withheld.size);
    // the auditor log endpoint itself requires the key
    expect((await fetch(`${urls.witnessUrl}/log`)).status).to.equal(401);
  });

  it("T6: unauthorized ACL changes and reads are refused, including by a deactivated clinician", async function () {
    const rid = P.randomBytes32();
    const rec = { pid, diagnosis: "hypertension", plan: "annual", nonce: P.randomNonceHex() };
    await (await c.connect(clin).addPhiRecord(rid, pid, P.recordDigest(rec))).wait();
    const clinSession = await login(clin);
    expect((await post(`${urls.gatewayUrl}/phi`, { rid, pid, record: rec }, { authorization: `Bearer ${clinSession.body.token}` })).status).to.equal(200);
    const docSession = await login(doc);
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const direct = await reverts(c.connect(outsider).grantPhiAccess(pid, outsider.address));
      const notResponsible = await reverts(c.connect(clin2).grantPhiAccess(pid, clin2.address));
      const read = await fetch(`${urls.gatewayUrl}/phi/${rid}`, { headers: { authorization: `Bearer ${docSession.body.token}` } });
      if (direct && notResponsible && read.status === 403) stopped++;
    }
    await (await c.connect(clin).grantPhiAccess(pid, doc.address)).wait();
    expect((await fetch(`${urls.gatewayUrl}/phi/${rid}`, { headers: { authorization: `Bearer ${docSession.body.token}` } })).status).to.equal(200);
    await (await c.connect(clin).revokePhiAccess(pid, doc.address)).wait();
    expect((await fetch(`${urls.gatewayUrl}/phi/${rid}`, { headers: { authorization: `Bearer ${docSession.body.token}` } })).status).to.equal(403);
    results.push({ id: "T6", scenario: "Outsider or non-responsible clinician changes the ACL; unlisted doctor reads", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T7: login with a reused nonce, a foreign nonce or another key's signature fails", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const ok = await login(doc);
      const reuse = await post(`${urls.gatewayUrl}/auth/login`, { address: doc.address, nonce: ok.nonce, signature: ok.signature });
      const n = await (await fetch(`${urls.gatewayUrl}/auth/nonce?address=${doc.address}`)).json();
      const wrongKey = await post(`${urls.gatewayUrl}/auth/login`, { address: doc.address, nonce: n.nonce, signature: await outsider.signMessage(n.message) });
      const n2 = await (await fetch(`${urls.gatewayUrl}/auth/nonce?address=${outsider.address}`)).json();
      const foreign = await post(`${urls.gatewayUrl}/auth/login`, { address: doc.address, nonce: n2.nonce, signature: await doc.signMessage(n2.message) });
      const noToken = await fetch(`${urls.gatewayUrl}/phi/${P.randomBytes32()}`);
      if (ok.status === 200 && reuse.status === 401 && wrongKey.status === 401 && foreign.status === 401 && noToken.status === 401) stopped++;
    }
    results.push({ id: "T7", scenario: "Log in with a reused or foreign nonce, or another key's signature", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T8: a second device cannot occupy another device's record identifiers", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      // device 2 tries to deposit under device 1's identifier and next sequence number
      const victimSeq = dev.seq;
      const spoof = { did: dev.did, seq: victimSeq.toString(), h: P.recordDigest({ squat: i }), t: Math.floor(Date.now() / 1000), dep };
      spoof.tag = P.deviceTag(dev2.key, spoof);
      const s = await post(`${urls.witnessUrl}/deposit`, spoof);
      // under its own identifier it can only create H(did2, seq), never H(did1, seq)
      const own = dev2.prepare(dev2.makeReading());
      const victim = await dev.submit(dev.makeReading(), urls); // the victim's record with that sequence number still commits
      if (s.status === 401 && own.rid !== P.recordId(dev.did, victimSeq) && victim.ok && BigInt(victim.seq) === victimSeq) stopped++;
    }
    results.push({ id: "T8", scenario: "Another device occupies a device's record identifier", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T9: a third party front-running the commitment does not make the gateway lose the record", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const rec = dev.makeReading();
      const { deposit, ingest } = dev.prepare(rec);
      await post(`${urls.witnessUrl}/deposit`, deposit);
      const att = await getAtt(P.recordId(deposit.did, deposit.seq));
      await (await commitAtt(att, {}, att.sig, outsider)).wait(); // anyone holding the attestation can commit it first
      const g = await post(`${urls.gatewayUrl}/ingest`, ingest);
      const session = await login(patient);
      const read = await fetch(`${urls.gatewayUrl}/device/${att.rid}`, { headers: { authorization: `Bearer ${session.body.token}` } });
      const served = read.status === 200 ? await read.json() : null;
      if (g.status === 200 && g.body.committedBy === "other" && served && P.recordDigest(served.record) === att.h) stopped++;
    }
    results.push({ id: "T9", scenario: "Third party front-runs the gateway's commitment with the same attestation", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });
});
