"use strict";
/**
 * Device simulator CLI.
 *   node device/simulator.js --n 50 --warmup 10 --out results/latency_localhost.csv
 *        2SDIF store path (channel 2 to the witness, channel 1 to the gateway)
 *   node device/simulator.js --n 20 --warmup 2 --jitter 12000 --retries 2
 *        public chain: random pause before each trial; failed attempts are retried and logged
 *   node device/simulator.js --baseline B0|B1|B2 --n 50 --warmup 10 --out results/latency_B1.csv
 *        single-channel baselines: B0 trusted gateway, B1 device secp256k1 signature, B2 device P-256 signature
 *        (needs scripts/bench-baselines.js to have deployed the baseline contracts and written the device keys)
 *   node device/simulator.js --n 30 --warmup 3 --gap 10000 --out results/ka_on_gap10.csv
 *        fixed idle time before each reading (keep-alive ablation; run with KEEPALIVE_MS=0 for no reuse)
 *   node device/simulator.js --fault-run --n 40 --gap 3000 --suppress-every 15 --out results/audit_truth.csv
 *        omission experiment against a faulty gateway (FAULT_* settings on the gateway): records the outcome
 *        of every reading (committed, withheld, delayed, suppressed) and the gateway receipts as ground truth
 *   node device/simulator.js --crypto 1000 --warmup 100 --out results/device_cost.csv
 *        device-side cost per record: digest, HMAC tag (2SDIF), secp256k1 and P-256 signatures (baselines)
 * Env: NETWORK, WITNESS_URL, GATEWAY_URL (default http://127.0.0.1:3001), BASELINE_URL (default
 *      http://127.0.0.1:3002), KEEPALIVE_MS (see shared/http.js)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { configureHttp, connectionCount } = require("../shared/http");
const { Device } = require("./device");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

function writeCsv(file, rows, quiet = false) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols = Object.keys(rows[0]);
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => r[c] ?? "").join(","))].join("\n") + "\n");
  if (!quiet) console.log(`[device] wrote ${rows.length} rows to ${file}`);
}
const f3 = (x) => (Number.isFinite(x) ? x.toFixed(3) : "");

// ---------------------------------------------------------------- baseline messages (match Baselines.sol)
const abi = ethers.AbiCoder.defaultAbiCoder();
function b1Message(chainId, contract, did, seq, h) {
  return ethers.keccak256(abi.encode(["string", "uint256", "address", "bytes32", "uint64", "bytes32"], ["2SDIF-B1", BigInt(chainId), contract, did, BigInt(seq), h]));
}
function b2Message(chainId, contract, did, seq, h) {
  return abi.encode(["string", "uint256", "address", "bytes32", "uint64", "bytes32"], ["2SDIF-B2", BigInt(chainId), contract, did, BigInt(seq), h]);
}

// ---------------------------------------------------------------- device-side cost
async function benchCrypto(dev, n, warmup, outFile) {
  const secp = new ethers.SigningKey(ethers.hexlify(crypto.randomBytes(32)));
  const { privateKey: p256 } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const chainId = 1n, contract = "0x0000000000000000000000000000000000000001";
  const rows = [];
  for (let i = 0; i < warmup + n; i++) {
    const rec = dev.makeReading();
    const seq = BigInt(rec.seq);
    const t0 = P.nowMs();
    const h = P.recordDigest(rec);
    const t1 = P.nowMs();
    P.deviceTag(dev.key, { did: dev.did, seq, h, t: Math.floor(Date.now() / 1000), dep: dev.dep });
    const t2 = P.nowMs();
    ethers.Signature.from(secp.sign(ethers.hashMessage(ethers.getBytes(b1Message(chainId, contract, dev.did, seq, h))))).serialized;
    const t3 = P.nowMs();
    crypto.sign("sha256", ethers.getBytes(b2Message(chainId, contract, dev.did, seq, h)), { key: p256, dsaEncoding: "ieee-p1363" });
    const t4 = P.nowMs();
    if (i >= warmup) {
      rows.push({ trial: i - warmup + 1, bytes: Buffer.byteLength(P.canonicalize(rec)), hashUs: f3((t1 - t0) * 1000), hmacUs: f3((t2 - t1) * 1000), totalUs: f3((t2 - t0) * 1000), secp256k1SignUs: f3((t3 - t2) * 1000), p256SignUs: f3((t4 - t3) * 1000) });
    }
  }
  writeCsv(outFile, rows);
}

// ---------------------------------------------------------------- 2SDIF store path
async function benchStore(dev, n, warmup, outFile, urls, jitterMs = 0, retries = 0, gapMs = 0) {
  const rows = [];
  const failures = [];
  const failFile = outFile.replace(/\.csv$/, "") + ".failures.json";
  for (let i = 0; i < warmup + n; i++) {
    let r, pausedMs = 0;
    for (let attempt = 0; ; attempt++) {
      // random pause so that submissions sample the block/slot phase uniformly (public chains),
      // or so that idle gaps between readings are realistic (keep-alive experiment)
      if (jitterMs > 0 || gapMs > 0) {
        pausedMs = gapMs + Math.random() * jitterMs;
        await new Promise((ok) => setTimeout(ok, pausedMs));
      }
      r = await dev.submit(dev.makeReading(), urls);
      if (r.ok) break;
      failures.push({ trial: i + 1, attempt: attempt + 1, stage: r.stage, status: r.status, body: r.body, at: new Date().toISOString() });
      fs.mkdirSync(path.dirname(failFile), { recursive: true });
      fs.writeFileSync(failFile, JSON.stringify(failures, null, 2));
      console.log(`[device] trial ${i + 1} attempt ${attempt + 1} failed at ${r.stage}: ${r.status} ${JSON.stringify(r.body)}`);
      if (attempt >= retries) throw new Error(`trial ${i + 1} failed at ${r.stage}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    if (i >= warmup) {
      const tm = r.body.timings || {};
      rows.push({
        trial: i - warmup + 1,
        seq: r.seq,
        startedAt: new Date(Date.now() - r.e2eMs).toISOString(),
        pausedMs: f3(pausedMs),
        depositMs: f3(r.depositMs),
        transferMs: f3(r.transferMs),
        fetchMs: f3(r.fetchMs),
        verifyMs: f3(r.verifyMs),
        commitMs: f3(r.commitMs),
        persistMs: f3(r.persistMs),
        e2eMs: f3(r.e2eMs),
        gasUsed: r.gasUsed,
        txHash: r.txHash || "",
        blockNumber: r.body.blockNumber ?? "",
        commitSentAt: r.body.commitSentAt ?? "",
        commitDoneAt: r.body.commitDoneAt ?? "",
        depositExecMs: f3(r.depositExecMs),
        fetchExecMs: f3(r.fetchExecMs),
        fetchAttempts: r.fetchAttempts ?? "",
        depositConns: r.depositConns ?? "",
        fetchConns: tm.fetchConns ?? "",
      });
      writeCsv(outFile, rows, true); // keep partial results if a later trial fails
    }
  }
  writeCsv(outFile, rows);
  if (failures.length) console.log(`[device] ${failures.length} failed attempt(s) recorded in ${failFile}`);
}

// ---------------------------------------------------------------- omission experiment (ground truth)
async function benchFault(dev, n, outFile, urls, gapMs, suppressEvery) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    if (gapMs > 0) await new Promise((ok) => setTimeout(ok, gapMs));
    const sentAt = Date.now();
    const suppressed = suppressEvery > 0 && i % suppressEvery === 0;
    const r = suppressed ? await dev.submitWithoutDeposit(dev.makeReading(), urls) : await dev.submit(dev.makeReading(), urls);
    let outcome;
    if (suppressed) outcome = r.status === 409 && r.body.error === "NoAttestation" ? "suppressed" : `suppressed-unexpected-${r.status}`;
    else if (r.status === 200) outcome = "committed";
    else if (r.status === 202) outcome = r.body.fault || "accepted";
    else outcome = `error-${r.stage}-${r.status}`;
    rows.push({ trial: i, seq: r.seq, rid: r.rid, outcome, sentAt, tW: r.tW ?? "", receipt: r.body && r.body.receipt ? 1 : 0 });
    writeCsv(outFile, rows, true);
    console.log(`[device] ${i}/${n} ${outcome}`);
  }
  writeCsv(outFile, rows);
  fs.writeFileSync(outFile.replace(/\.csv$/, "") + ".receipts.json", JSON.stringify(dev.receipts, null, 2));
}

// ---------------------------------------------------------------- baselines (single channel)
async function benchBaseline(mode, dev, n, warmup, outFile, baselineUrl) {
  const net = cfg.network();
  const b = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, "deployments", `baselines_${net}.json`), "utf8"));
  const keys = JSON.parse(fs.readFileSync(path.join(cfg.ROOT, "deployments", `baseline_keys_${net}.json`), "utf8"));
  const secp = new ethers.SigningKey(keys.secp256k1);
  const p256 = crypto.createPrivateKey(keys.p256Pem);
  const rows = [];
  for (let i = 0; i < warmup + n; i++) {
    const rec = dev.makeReading();
    const seq = BigInt(rec.seq);
    const t0 = P.nowMs();
    const h = P.recordDigest(rec);
    let sig = null;
    if (mode === "B1") sig = ethers.Signature.from(secp.sign(ethers.hashMessage(ethers.getBytes(b1Message(b.chainId, b.B1, dev.did, seq, h))))).serialized;
    if (mode === "B2") {
      const s = crypto.sign("sha256", ethers.getBytes(b2Message(b.chainId, b.B2, dev.did, seq, h)), { key: p256, dsaEncoding: "ieee-p1363" });
      sig = { r: "0x" + s.subarray(0, 32).toString("hex"), s: "0x" + s.subarray(32).toString("hex") };
    }
    const signMs = P.nowMs() - t0;
    const t1 = P.nowMs();
    const gr = await fetch(`${baselineUrl}/ingest/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ did: dev.did, seq: seq.toString(), record: rec, sig }) });
    const body = await gr.json();
    const rt = P.nowMs() - t1;
    if (gr.status !== 200) throw new Error(`${mode} trial ${i + 1} failed: ${gr.status} ${JSON.stringify(body)}`);
    if (i >= warmup) {
      const tm = body.timings;
      // e2eMs excludes the device's signing time (signMs), as the 2SDIF e2eMs excludes its digest and tag:
      // device-side cryptography is reported separately (--crypto), since a PC does not represent a sensor
      rows.push({ trial: i - warmup + 1, mode, signMs: f3(signMs), transferMs: f3(rt - tm.totalMs), verifyMs: f3(tm.verifyMs), commitMs: f3(tm.commitMs), persistMs: f3(tm.persistMs), e2eMs: f3(rt), gasUsed: body.gasUsed });
    }
  }
  writeCsv(outFile, rows);
}

async function main() {
  configureHttp();
  const devices = cfg.devices();
  const label = arg("device", devices[0].label);
  const d = devices.find((x) => x.label === label);
  const net = cfg.network();
  if (arg("crypto")) {
    const dev = new Device({ ...d, dep: P.deploymentId(1, "0x0000000000000000000000000000000000000001") });
    return benchCrypto(dev, Number(arg("crypto")), Number(arg("warmup", 100)), arg("out", path.join(cfg.ROOT, "results", "device_cost.csv")));
  }
  const deployment = cfg.deployment(net);
  const dev = new Device({ ...d, dep: P.deploymentId(deployment.chainId, deployment.address) });
  if (arg("baseline")) {
    const mode = arg("baseline");
    const url = (process.env.BASELINE_URL || "http://127.0.0.1:3002").replace(/\/$/, "");
    return benchBaseline(mode, dev, Number(arg("n", 50)), Number(arg("warmup", 10)), arg("out", path.join(cfg.ROOT, "results", `latency_${mode}.csv`)), url);
  }
  const urls = {
    witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""),
    gatewayUrl: (process.env.GATEWAY_URL || "http://127.0.0.1:3001").replace(/\/$/, ""),
  };
  if (process.argv.includes("--fault-run")) {
    return benchFault(dev, Number(arg("n", 40)), arg("out", path.join(cfg.ROOT, "results", "audit_truth.csv")), urls, Number(arg("gap", 3000)), Number(arg("suppress-every", 0)));
  }
  await benchStore(dev, Number(arg("n", 50)), Number(arg("warmup", 10)), arg("out", path.join(cfg.ROOT, "results", `latency_${net}.csv`)), urls, Number(arg("jitter", 0)), Number(arg("retries", 0)), Number(arg("gap", 0)));
  if (process.argv.includes("--save-receipts")) {
    fs.writeFileSync(arg("out").replace(/\.csv$/, "") + ".receipts.json", JSON.stringify(dev.receipts, null, 2));
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { b1Message, b2Message };
