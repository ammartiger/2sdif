"use strict";
/**
 * Gas per contract operation, read from transaction receipts (deterministic for identical inputs).
 *   npx hardhat run scripts/gas-report.js                 (in-process Hardhat network)
 *   npx hardhat run scripts/gas-report.js --network sepolia   (spot check; costs test ETH)
 * Writes results/gas_<network>.csv
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const P = require("../shared/protocol");

async function main() {
  const { ethers, network } = hre;
  const signers = await ethers.getSigners();
  const [admin, clin, doc, patient, store] = signers.length >= 5 ? signers : [signers[0], signers[0], signers[0], signers[0], signers[0]];
  const witness = ethers.Wallet.createRandom();
  const rows = [];
  const rec = async (op, txp, by) => { const rc = await (await txp).wait(); rows.push({ operation: op, gasUsed: rc.gasUsed.toString(), signedBy: by }); return rc; };

  const Factory = await ethers.getContractFactory("TwoSDIFRegistry", admin);
  const c = await Factory.deploy(witness.address);
  const drc = await c.deploymentTransaction().wait();
  rows.push({ operation: "Contract deployment", gasUsed: drc.gasUsed.toString(), signedBy: "Administrator" });
  const chainId = (await ethers.provider.getNetwork()).chainId;
  const contract = await c.getAddress();

  const pid = P.toBytes32Id("patient-gas");
  await rec("Register clinician", c.connect(admin).registerClinician(clin.address, P.recordDigest({ name: "Dr A" })), "Administrator");
  await rec("Register patient", c.connect(admin).registerPatient(pid, patient.address, clin.address, P.recordDigest({ name: "P" })), "Administrator");

  const record = { did: P.toBytes32Id("sensor-gas"), pid, hr: 72, nonce: P.randomNonceHex() };
  const fields = { chainId, contract, rid: P.randomBytes32(), h: P.recordDigest(record), did: record.did, tW: Math.floor(Date.now() / 1000) };
  const sig = await P.signAttestation(witness, fields);
  await rec("commitProof (attested device record)", c.connect(store).commitProof(fields.rid, fields.h, fields.did, fields.tW, sig), "Gateway");

  await rec("Add health information record", c.connect(clin).addPhiRecord(P.randomBytes32(), pid, P.recordDigest({ dx: "x" })), "Responsible clinician");
  await rec("Grant health information access", c.connect(clin).grantPhiAccess(pid, doc.address), "Responsible clinician");
  await rec("Revoke health information access", c.connect(clin).revokePhiAccess(pid, doc.address), "Responsible clinician");
  const rxId = P.randomBytes32();
  await rec("Add prescription", c.connect(clin).addPrescription(rxId, pid, P.recordDigest({ rx: "y" })), "Clinician");
  await rec("Grant prescription access", c.connect(clin).grantRxAccess(rxId, store.address), "Prescriber");
  await rec("Revoke prescription access", c.connect(clin).revokeRxAccess(rxId, store.address), "Prescriber");

  const dir = path.join(__dirname, "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `gas_${network.name}.csv`);
  fs.writeFileSync(file, ["operation,gasUsed,signedBy", ...rows.map((r) => `"${r.operation}",${r.gasUsed},${r.signedBy}`)].join("\n") + "\n");
  console.table(rows);
  console.log(`written ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
