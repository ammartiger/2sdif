/**
 * End-to-end attack suite T1-T7 (paper, Table "Attack suite").
 * Runs the real witness app, gateway app and device code in-process against the Hardhat network.
 * ATTACK_RUNS (default 20) repetitions per scenario; writes results/attacks_<network>.csv.
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

function listen(app) {
  return new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

describe("End-to-end attack suite", function () {
  if (REMOTE) this.timeout(0); // network round trips to a deployed witness
  let c, admin, clin, clin2, doc, patient, outsider, gwSigner, witnessWallet, witnessCore, witnessSrv, gatewaySrv, dev, urls, chainId, pid, auditorKey;

  async function ensureClinician(addr, tag) {
    if (!(await c.isClinician(addr))) await (await c.registerClinician(addr, P.recordDigest({ n: tag }))).wait();
  }

  before(async function () {
    [admin, clin, clin2, doc, patient, outsider, gwSigner] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;
    if (REMOTE) {
      // attach to the deployment the remote witness is bound to; distinct pid so other benchmarks do not collide
      const dep = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8"));
      const health = await (await fetch(`${REMOTE}/health`)).json();
      if (health.contract.toLowerCase() !== dep.address.toLowerCase() || health.chainId !== String(chainId)) {
        throw new Error(`remote witness is bound to ${health.contract} on chain ${health.chainId}, not ${dep.address} on ${chainId}`);
      }
      witnessWallet = { address: health.witness };
      c = (await ethers.getContractAt("TwoSDIFRegistry", dep.address)).connect(admin);
      pid = P.toBytes32Id(`attack-patient-${Date.now()}`);
      const d0 = JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || path.join(__dirname, "..", "devices.json"), "utf8")).devices[0];
      dev = new Device({ label: d0.label, key: d0.key, pid: "patient-01" });
      auditorKey = process.env.AUDITOR_KEY;
    } else {
      witnessWallet = ethers.Wallet.createRandom();
      c = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witnessWallet.address);
      pid = P.toBytes32Id("patient-01");
    }
    await ensureClinician(clin.address, "clin");
    await ensureClinician(clin2.address, "clin2");
    await (await c.registerPatient(pid, patient.address, clin.address, P.recordDigest({ n: "p" }))).wait();

    let witnessUrl;
    if (REMOTE) {
      witnessUrl = REMOTE;
    } else {
      const key = crypto.randomBytes(32).toString("hex");
      dev = new Device({ label: "sensor-01", key, pid: "patient-01" });
      auditorKey = crypto.randomBytes(16).toString("hex");
      witnessCore = new Witness({
        signer: witnessWallet,
        deviceKeys: parseDeviceKeys({ [dev.did]: key }),
        store: new MemoryStore(),
        chainId,
        contract: await c.getAddress(),
      });
      witnessSrv = await listen(createWitnessApp(witnessCore, { auditorKey }));
      witnessUrl = `${witnessSrv.url}/api`;
    }
    const gwContract = c.connect(gwSigner);
    gatewaySrv = await listen(
      createGateway({
        contract: gwContract,
        witnessUrl,
        witnessAddress: witnessWallet.address,
        chainId,
        store: new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), "2sdif-"))),
      })
    );
    urls = { witnessUrl, gatewayUrl: gatewaySrv.url };
  });

  after(function () {
    if (witnessSrv) witnessSrv.server.close();
    if (gatewaySrv) gatewaySrv.server.close();
    const dir = path.join(__dirname, "..", "results");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `attacks_${REMOTE ? "remote" : network.name}.csv`);
    fs.writeFileSync(file, ["id,scenario,runs,stopped", ...results.map((r) => `${r.id},"${r.scenario}",${r.runs},${r.stopped}`)].join("\n") + "\n");
  });

  async function post(url, body, headers = {}) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  async function login(signer) {
    const n = await (await fetch(`${urls.gatewayUrl}/auth/nonce?address=${signer.address}`)).json();
    const signature = await signer.signMessage(n.message);
    const r = await post(`${urls.gatewayUrl}/auth/login`, { address: signer.address, nonce: n.nonce, signature });
    return { ...r, nonce: n.nonce, signature };
  }

  it("honest path commits a device record (sanity)", async function () {
    const r = await dev.submit(dev.makeReading(), urls);
    expect(r.ok, JSON.stringify(r.body)).to.equal(true);
    const p = await c.getProof(r.rid);
    expect(p.digest).to.equal(r.body.digest);
  });

  it("T1: tampering with the record on channel 1 is rejected", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const rec = dev.makeReading();
      const { deposit, ingest } = dev.prepare(rec);
      expect((await post(`${urls.witnessUrl}/deposit`, deposit)).status).to.equal(201);
      const tampered = { ...ingest, record: { ...ingest.record, hr: ingest.record.hr + 30 } };
      const g = await post(`${urls.gatewayUrl}/ingest`, tampered);
      // forced path: even if the gateway commits the tampered digest, the contract refuses it
      const att = (await (await fetch(`${urls.witnessUrl}/attestation/${deposit.rid}`)).json());
      let forcedReverted = false;
      try {
        await (await c.connect(gwSigner).commitProof(att.rid, P.recordDigest(tampered.record), att.did, att.tW, att.sig)).wait();
      } catch { forcedReverted = true; }
      if (g.status === 409 && g.body.error === "IntegrityViolation" && forcedReverted) stopped++;
    }
    results.push({ id: "T1", scenario: "Member node modifies the record on channel 1", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T2: a deposit without the device key is rejected by the witness", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const rogue = new Device({ label: "sensor-01", key: crypto.randomBytes(32).toString("hex"), pid: "patient-01" });
      const { deposit } = rogue.prepare(rogue.makeReading());
      const r1 = await post(`${urls.witnessUrl}/deposit`, deposit);
      // valid tag reused for a different digest
      const { deposit: good } = dev.prepare(dev.makeReading());
      const r2 = await post(`${urls.witnessUrl}/deposit`, { ...good, h: P.recordDigest({ forged: i }) });
      if (r1.status === 401 && r2.status === 401) stopped++;
    }
    results.push({ id: "T2", scenario: "Deposit a digest without the device key", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T3: a compromised gateway cannot commit an altered or self-attested digest", async function () {
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const { deposit } = dev.prepare(dev.makeReading());
      await post(`${urls.witnessUrl}/deposit`, deposit);
      const att = await (await fetch(`${urls.witnessUrl}/attestation/${deposit.rid}`)).json();
      const altered = P.recordDigest({ altered: i });
      let a = false, b = false;
      try { await (await c.connect(gwSigner).commitProof(att.rid, altered, att.did, att.tW, att.sig)).wait(); } catch { a = true; }
      const self = await P.signAttestation(gwSigner, { chainId, contract: await c.getAddress(), rid: att.rid, h: altered, did: att.did, tW: att.tW });
      try { await (await c.connect(gwSigner).commitProof(att.rid, altered, att.did, att.tW, self)).wait(); } catch { b = true; }
      if (a && b) stopped++;
    }
    results.push({ id: "T3", scenario: "Gateway commits an altered or self-attested digest", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T4: replayed deposits, commitments and cross-deployment attestations are rejected", async function () {
    const c2 = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witnessWallet.address);
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      const r = await dev.submit(dev.makeReading(), urls);
      const att = await (await fetch(`${urls.witnessUrl}/attestation/${r.rid}`)).json();
      const reDeposit = await post(`${urls.witnessUrl}/deposit`, { did: att.did, rid: att.rid, h: att.h, t: att.tW, tag: P.deviceTag(dev.key, { did: att.did, rid: att.rid, h: att.h, t: att.tW }) });
      let reCommit = false, cross = false;
      try { await (await c.connect(gwSigner).commitProof(att.rid, att.h, att.did, att.tW, att.sig)).wait(); } catch { reCommit = true; }
      try { await (await c2.connect(gwSigner).commitProof(att.rid, att.h, att.did, att.tW, att.sig)).wait(); } catch { cross = true; }
      if (r.ok && reDeposit.status === 409 && reCommit && cross) stopped++;
    }
    results.push({ id: "T4", scenario: "Replay a deposit, a commitment or an attestation on another deployment", runs: RUNS, stopped });
    expect(stopped).to.equal(RUNS);
  });

  it("T5: withheld records are flagged by the auditor", async function () {
    const TOTAL = 60, WITHHOLD = 10;
    const fromBlock = await ethers.provider.getBlockNumber();
    const since = Math.floor(Date.now() / 1000) - (REMOTE ? 300 : 1); // remote: tolerate clock skew with the witness host
    const withheld = new Set();
    const runRids = new Set(); // this run's records (earlier tests left attested-but-uncommitted records in the log)
    for (let i = 0; i < TOTAL; i++) {
      const { deposit } = dev.prepare(dev.makeReading());
      const d = await post(`${urls.witnessUrl}/deposit`, deposit);
      runRids.add(deposit.rid.toLowerCase());
      if (i % (TOTAL / WITHHOLD) === 0) { withheld.add(deposit.rid.toLowerCase()); continue; } // modified gateway: never commits
      await (await c.connect(gwSigner).commitProof(d.body.rid, d.body.h, d.body.did, d.body.tW, d.body.sig)).wait();
    }
    const log = await (await fetch(`${urls.witnessUrl}/log?since=${since}`, { headers: { "x-auditor-key": auditorKey, "x-functions-key": auditorKey } })).json();
    const committed = await committedProofs(c, fromBlock);
    const deltaSec = 30;
    const entries = log.entries.filter((e) => runRids.has(e.rid));
    expect(entries.length).to.equal(TOTAL);
    const report = auditEntries({ entries, committed, nowSec: Math.floor(Date.now() / 1000) + deltaSec + (REMOTE ? 60 : 1), deltaSec });
    const flagged = report.omitted.filter((rid) => withheld.has(rid)).length;
    const falsePositives = report.omitted.length - flagged;
    results.push({ id: "T5", scenario: `Gateway withholds ${WITHHOLD} of ${TOTAL} records (flagged ${flagged}, false positives ${falsePositives})`, runs: 1, stopped: flagged === WITHHOLD && falsePositives === 0 ? 1 : 0 });
    expect(flagged).to.equal(WITHHOLD);
    expect(falsePositives).to.equal(0);
    // the auditor log endpoint itself requires the key
    expect((await fetch(`${urls.witnessUrl}/log`)).status).to.equal(401);
  });

  it("T6: unauthorized ACL changes and reads are refused", async function () {
    // clinician stores one PHI record through the proper path
    const rid = P.randomBytes32();
    const rec = { pid, diagnosis: "hypertension", plan: "annual", nonce: P.randomNonceHex() };
    await (await c.connect(clin).addPhiRecord(rid, pid, P.recordDigest(rec))).wait();
    const clinSession = await login(clin);
    const stored = await post(`${urls.gatewayUrl}/phi`, { rid, pid, record: rec }, { authorization: `Bearer ${clinSession.body.token}` });
    expect(stored.status).to.equal(200);
    const docSession = await login(doc);
    let stopped = 0;
    for (let i = 0; i < RUNS; i++) {
      let direct = false;
      try { await (await c.connect(outsider).grantPhiAccess(pid, outsider.address)).wait(); } catch { direct = true; }
      let notResponsible = false;
      try { await (await c.connect(clin2).grantPhiAccess(pid, clin2.address)).wait(); } catch { notResponsible = true; }
      const read = await fetch(`${urls.gatewayUrl}/phi/${rid}`, { headers: { authorization: `Bearer ${docSession.body.token}` } });
      if (direct && notResponsible && read.status === 403) stopped++;
    }
    // after a legitimate grant the same doctor can read, and after revocation cannot
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
});
