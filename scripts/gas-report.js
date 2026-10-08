"use strict";
/**
 * Gas per contract operation, read from transaction receipts (deterministic for identical inputs).
 *   npx hardhat run scripts/gas-report.js                     (in-process Hardhat network, Osaka schedule)
 *   npx hardhat run scripts/gas-report.js --network sepolia   (current Sepolia schedule; costs a little test ETH)
 * Covers 2SDIF and the three baselines (B0 trusted gateway, B1 device secp256k1 signature, B2 device P-256
 * signature via the EIP-7951 precompile). Commitments are repeated COMMITS times (default 10) and reported as
 * min / median / max, since calldata zero bytes make them vary by a few gas.
 * Writes results/gas_<network>.csv
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hre = require("hardhat");
const P = require("../shared/protocol");

const COMMITS = Number(process.env.COMMITS || 10);

async function feeOverrides(ethers, network) {
  if (network.name !== "sepolia") return {};
  // Use the provider's suggested priority fee rather than a 1 gwei default; Sepolia fees are tiny.
  const tip = BigInt(await ethers.provider.send("eth_maxPriorityFeePerGas", []));
  const base = (await ethers.provider.getBlock("latest")).baseFeePerGas || 0n;
  return { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
}

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [admin, clin, doc, patient, store] = signers.length >= 5 ? signers : [signers[0], signers[0], signers[0], signers[0], signers[0]];
  const witness = ethers.Wallet.createRandom();
  const fee = await feeOverrides(ethers, network);
  const rows = [];
  const median = (v) => { const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };
  const rec = async (op, txp, by, design = "2SDIF") => {
    const rc = await (await txp).wait();
    rows.push({ design, operation: op, gasUsed: rc.gasUsed.toString(), min: "", max: "", signedBy: by });
    return rc;
  };
  const recMany = async (op, makeTx, by, design) => {
    const g = [];
    for (let i = 0; i < COMMITS; i++) g.push(Number((await (await makeTx(i)).wait()).gasUsed));
    rows.push({ design, operation: op, gasUsed: String(median(g)), min: String(Math.min(...g)), max: String(Math.max(...g)), signedBy: by });
  };
  const deployed = async (name, args, by, design) => {
    const c = await (await ethers.getContractFactory(name, admin)).deploy(...args, fee);
    const rc = await c.deploymentTransaction().wait();
    rows.push({ design, operation: "Contract deployment", gasUsed: rc.gasUsed.toString(), min: "", max: "", signedBy: by });
    return c;
  };

  // ---------------------------------------------------------------- 2SDIF
  const c = await deployed("TwoSDIFRegistry", [witness.address, 86400], "Administrator", "2SDIF");
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const contract = await c.getAddress();
  const pid = P.toBytes32Id(`patient-gas-${Date.now()}`);
  await rec("Register clinician", c.connect(admin).registerClinician(clin.address, P.recordDigest({ name: "Dr A" }), fee), "Administrator");
  if (doc.address !== clin.address) await (await c.connect(admin).registerClinician(doc.address, P.recordDigest({ name: "Dr B" }), fee)).wait();
  await (await c.connect(admin).registerMedicalStore(store.address, true, fee)).wait();
  await rec("Register patient", c.connect(admin).registerPatient(pid, patient.address, clin.address, P.recordDigest({ name: "P" }), fee), "Administrator");
  const did = P.toBytes32Id("sensor-gas");
  const seq0 = BigInt(Date.now()) * 1000n;
  await recMany("Attested commitment (commitProof)", async (i) => {
    const f = { chainId, contract, did, seq: seq0 + BigInt(i), h: P.recordDigest({ hr: 70 + i, n: P.randomNonceHex() }), tW: Math.floor(Date.now() / 1000) };
    return c.connect(store).commitProof(f.did, f.seq, f.h, f.tW, await P.signAttestation(witness, f), fee);
  }, "Gateway", "2SDIF");
  await rec("Add health information record", c.connect(clin).addPhiRecord(P.randomBytes32(), pid, P.recordDigest({ dx: "x" }), fee), "Responsible clinician");
  await rec("Grant health information access", c.connect(clin).grantPhiAccess(pid, doc.address, fee), "Responsible clinician");
  await rec("Revoke health information access", c.connect(clin).revokePhiAccess(pid, doc.address, fee), "Responsible clinician");
  const rxId = P.randomBytes32();
  await rec("Add prescription", c.connect(clin).addPrescription(rxId, pid, P.recordDigest({ rx: "y" }), fee), "Clinician");
  await rec("Grant prescription access", c.connect(clin).grantRxAccess(rxId, store.address, fee), "Prescriber");
  await rec("Revoke prescription access", c.connect(clin).revokeRxAccess(rxId, store.address, fee), "Prescriber");

  // ---------------------------------------------------------------- 2SDIF, batched (one root per batch)
  for (const k of (process.env.BATCH_SIZES || "4,16,64").split(",").map(Number)) {
    const items = [];
    for (let i = 0; i < k; i++) {
      const f = { chainId, contract, did, seq: seq0 + 1000n * BigInt(k) + BigInt(i), h: P.recordDigest({ batch: k, i, n: P.randomNonceHex() }), tW: Math.floor(Date.now() / 1000) };
      items.push({ deviceId: f.did, seq: f.seq, digest: f.h, witnessTime: f.tW, signature: await P.signAttestation(witness, f) });
    }
    const rc = await (await c.connect(store).commitBatch(items, fee)).wait();
    rows.push({ design: "2SDIF-batch", operation: `Batched commitment k=${k} (per record)`, gasUsed: String(Math.round(Number(rc.gasUsed) / k)), min: "", max: "", signedBy: "Gateway" });
    rows.push({ design: "2SDIF-batch", operation: `Batched commitment k=${k} (transaction)`, gasUsed: rc.gasUsed.toString(), min: "", max: "", signedBy: "Gateway" });
  }

  // ---------------------------------------------------------------- B0: trusted gateway
  const b0 = await deployed("TrustedGatewayRegistry", [store.address], "Administrator", "B0");
  await recMany("Commitment (trusted gateway)", (i) => b0.connect(store).commit(did, seq0 + BigInt(i), P.recordDigest({ b0: i, n: P.randomNonceHex() }), fee), "Gateway", "B0");

  // ---------------------------------------------------------------- B1: device secp256k1 signature
  const b1 = await deployed("DeviceSignedRegistry", [], "Administrator", "B1");
  const devKey = ethers.Wallet.createRandom();
  await rec("Register device key", b1.connect(admin).registerDevice(did, devKey.address, fee), "Administrator", "B1");
  await recMany("Commitment (device secp256k1 signature)", async (i) => {
    const h = P.recordDigest({ b1: i, n: P.randomNonceHex() });
    const sig = await devKey.signMessage(ethers.getBytes(await b1.message(did, seq0 + BigInt(i), h)));
    return b1.connect(store).commit(did, seq0 + BigInt(i), h, sig, fee);
  }, "Gateway", "B1");

  // ---------------------------------------------------------------- B2: device P-256 signature (EIP-7951)
  const b2 = await deployed("DeviceP256Registry", [], "Administrator", "B2");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const hex = (b64) => "0x" + Buffer.from(b64, "base64url").toString("hex");
  await rec("Register device key", b2.connect(admin).registerDevice(did, hex(jwk.x), hex(jwk.y), fee), "Administrator", "B2");
  await recMany("Commitment (device P-256 signature)", async (i) => {
    const h = P.recordDigest({ b2: i, n: P.randomNonceHex() });
    const msg = await b2.message(did, seq0 + BigInt(i), h);
    const sig = crypto.sign("sha256", Buffer.from(msg.slice(2), "hex"), { key: privateKey, dsaEncoding: "ieee-p1363" });
    return b2.connect(store).commit(did, seq0 + BigInt(i), h, "0x" + sig.subarray(0, 32).toString("hex"), "0x" + sig.subarray(32).toString("hex"), fee);
  }, "Gateway", "B2");

  const dir = path.join(__dirname, "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gas_${network.name}.csv`);
  fs.writeFileSync(file, ["design,operation,gasUsed,min,max,signedBy", ...rows.map((r) => `${r.design},"${r.operation}",${r.gasUsed},${r.min},${r.max},${r.signedBy}`)].join("\n") + "\n");
  console.table(rows);
  console.log(`written ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
