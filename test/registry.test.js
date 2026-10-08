const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const P = require("../shared/protocol");

describe("TwoSDIFRegistry (contract level)", function () {
  let c, admin, clin, clin2, doc, patient, store, outsider, gw, witness, chainId, pid;
  const DELAY = 3600;

  beforeEach(async function () {
    [admin, clin, clin2, doc, patient, store, outsider, gw] = await ethers.getSigners();
    witness = ethers.Wallet.createRandom();
    c = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witness.address, DELAY);
    chainId = (await ethers.provider.getNetwork()).chainId;
    pid = P.toBytes32Id("patient-01");
    await c.registerClinician(clin.address, P.recordDigest({ n: "clin" }));
    await c.registerClinician(clin2.address, P.recordDigest({ n: "clin2" }));
    await c.registerClinician(doc.address, P.recordDigest({ n: "doc" }));
    await c.registerMedicalStore(store.address, true);
    await c.registerPatient(pid, patient.address, clin.address, P.recordDigest({ n: "p" }));
  });

  let seqCounter = 1000n;
  async function attest(fields = {}, signer = witness) {
    const full = { chainId, contract: await c.getAddress(), did: P.toBytes32Id("s1"), seq: (seqCounter += 1n), h: P.recordDigest({ a: Number(seqCounter) }), tW: Math.floor(Date.now() / 1000), ...fields };
    return { full, rid: P.recordId(full.did, full.seq), sig: await P.signAttestation(signer, full) };
  }
  const commit = (contract, f, sig, from) => (from ? contract.connect(from) : contract).commitProof(f.did, f.seq, f.h, f.tW, sig);

  describe("attested commitments", function () {
    it("accepts a digest attested by the registered witness, from any submitter", async function () {
      const { full, rid, sig } = await attest();
      await expect(commit(c, full, sig, gw)).to.emit(c, "ProofCommitted");
      expect(await c.getProof(rid)).to.equal(full.h);
    });

    it("derives the record id from the device and sequence number exactly as off chain", async function () {
      const did = P.toBytes32Id("s9");
      expect(await c.recordId(did, 77)).to.equal(P.recordId(did, 77));
    });

    it("matches the off-chain attestation message", async function () {
      const f = { did: P.toBytes32Id("s1"), seq: 5n, h: P.recordDigest({ a: 2 }), tW: 123 };
      const onchain = await c.attestationMessage(f.did, f.seq, f.h, f.tW);
      expect(onchain).to.equal(P.attestationMessage({ chainId, contract: await c.getAddress(), ...f }));
    });

    it("rejects an altered digest carrying a valid attestation for the original (gateway substitution)", async function () {
      const { full, sig } = await attest();
      await expect(commit(c, { ...full, h: P.recordDigest({ a: 999 }) }, sig, gw)).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("rejects an attestation moved to another device or sequence number", async function () {
      const { full, sig } = await attest();
      await expect(commit(c, { ...full, did: P.toBytes32Id("s2") }, sig, gw)).to.be.revertedWithCustomError(c, "InvalidAttestation");
      await expect(commit(c, { ...full, seq: full.seq + 1n }, sig, gw)).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("rejects an attestation signed by anyone other than the witness", async function () {
      const { full, sig } = await attest({}, ethers.Wallet.createRandom());
      await expect(commit(c, full, sig, gw)).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("rejects malformed signatures", async function () {
      await expect(c.commitProof(P.toBytes32Id("s1"), 1, P.recordDigest({ a: 1 }), 1, "0x1234")).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("is write once per record id", async function () {
      const { full, sig } = await attest();
      await commit(c, full, sig);
      await expect(commit(c, full, sig)).to.be.revertedWithCustomError(c, "AlreadyCommitted");
    });

    it("rejects an attestation replayed on a second deployment", async function () {
      const { full, sig } = await attest();
      const c2 = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witness.address, DELAY);
      await expect(commit(c2, full, sig)).to.be.revertedWithCustomError(c2, "InvalidAttestation");
    });

    it("rotates the witness only after an announced delay, and only by the administrator", async function () {
      await expect(c.connect(outsider).proposeWitness(outsider.address)).to.be.revertedWithCustomError(c, "NotAdmin");
      await expect(c.proposeWitness(outsider.address)).to.emit(c, "WitnessChangeProposed");
      await expect(c.activateWitness()).to.be.revertedWithCustomError(c, "WitnessChangeNotReady");
      const snap = await network.provider.send("evm_snapshot");
      await network.provider.send("evm_increaseTime", [DELAY + 1]);
      await network.provider.send("evm_mine");
      await expect(c.activateWitness()).to.emit(c, "WitnessChanged");
      expect(await c.witness()).to.equal(outsider.address);
      await network.provider.send("evm_revert", [snap]); // keep the chain clock on wall-clock time for later tests
    });
  });

  describe("batched commitments", function () {
    const M = require("../shared/merkle");
    async function batch(k) {
      const items = [];
      for (let i = 0; i < k; i++) {
        const { full, rid, sig } = await attest();
        items.push({ deviceId: full.did, seq: full.seq, digest: full.h, witnessTime: full.tW, signature: sig, rid });
      }
      return items;
    }
    const strip = (items) => items.map(({ rid, ...x }) => x);

    for (const k of [1, 2, 5, 8]) {
      it(`commits ${k} attested proofs under one Merkle root that matches the off-chain tree and verifies every leaf`, async function () {
        const items = await batch(k);
        const leaves = items.map((x) => M.leaf(x.rid, x.digest));
        const root = M.root(leaves);
        await expect(c.connect(gw).commitBatch(strip(items))).to.emit(c, "BatchCommitted").withArgs(root, k, gw.address);
        expect(await c.batchRoots(root)).to.not.equal(0n);
        for (let i = 0; i < k; i++) {
          expect(await c.verifyBatched(items[i].rid, items[i].digest, i, k, M.proof(leaves, i), root)).to.equal(true);
          expect(await c.verifyBatched(items[i].rid, P.recordDigest({ x: i }), i, k, M.proof(leaves, i), root)).to.equal(false);
        }
      });
    }

    it("rejects a batch containing one altered digest", async function () {
      const items = await batch(4);
      items[2] = { ...items[2], digest: P.recordDigest({ altered: true }) };
      await expect(c.connect(gw).commitBatch(strip(items))).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("announces every record of a batch with ProofCommitted, as the auditor expects", async function () {
      const items = await batch(3);
      const rc = await (await c.connect(gw).commitBatch(strip(items))).wait();
      const rids = rc.logs.map((l) => c.interface.parseLog(l)).filter((e) => e && e.name === "ProofCommitted").map((e) => e.args.rid);
      expect(rids).to.deep.equal(items.map((x) => x.rid));
    });
  });

  describe("access control", function () {
    it("lets only the administrator register participants", async function () {
      await expect(c.connect(outsider).registerClinician(outsider.address, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "NotAdmin");
      await expect(c.connect(outsider).registerPatient(P.toBytes32Id("x"), outsider.address, clin.address, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "NotAdmin");
    });

    it("lets only the responsible clinician grant and revoke PHI access, and only to clinicians", async function () {
      await expect(c.connect(outsider).grantPhiAccess(pid, outsider.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await expect(c.connect(clin2).grantPhiAccess(pid, clin2.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await expect(c.connect(clin).grantPhiAccess(pid, outsider.address)).to.be.revertedWithCustomError(c, "NotAllowedReader");
      expect(await c.canReadPhi(pid, doc.address)).to.equal(false);
      await c.connect(clin).grantPhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(true);
      await c.connect(clin).revokePhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(false);
    });

    it("moves ACL authority and default access when the administrator reassigns the clinician", async function () {
      await c.reassignClinician(pid, clin2.address);
      await expect(c.connect(clin).grantPhiAccess(pid, doc.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      expect(await c.canReadPhi(pid, clin.address)).to.equal(false);
      await c.connect(clin2).grantPhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(true);
    });

    it("withdraws ACL rights and reads from a deactivated clinician, including granted access", async function () {
      await c.connect(clin).grantPhiAccess(pid, doc.address);
      await c.deactivateClinician(doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(false);
      await c.deactivateClinician(clin.address);
      expect(await c.canReadPhi(pid, clin.address)).to.equal(false);
      await expect(c.connect(clin).grantPhiAccess(pid, clin2.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
    });

    it("gives patients and responsible clinicians read access by default", async function () {
      expect(await c.canReadPhi(pid, patient.address)).to.equal(true);
      expect(await c.canReadPhi(pid, clin.address)).to.equal(true);
      expect(await c.canReadPhi(pid, outsider.address)).to.equal(false);
    });

    it("enforces prescription rules (prescriber, responsible clinician, registered stores only if granted)", async function () {
      const rx = P.randomBytes32();
      await expect(c.connect(outsider).addPrescription(rx, pid, P.recordDigest({ r: 1 }))).to.be.revertedWithCustomError(c, "NotClinician");
      await c.connect(clin2).addPrescription(rx, pid, P.recordDigest({ r: 1 }));
      expect(await c.canReadRx(rx, clin2.address)).to.equal(true); // prescriber
      expect(await c.canReadRx(rx, clin.address)).to.equal(true); // responsible clinician
      expect(await c.canReadRx(rx, store.address)).to.equal(false);
      await expect(c.connect(outsider).grantRxAccess(rx, store.address)).to.be.revertedWithCustomError(c, "NotPrescriberOrResponsible");
      await expect(c.connect(clin2).grantRxAccess(rx, outsider.address)).to.be.revertedWithCustomError(c, "NotAllowedReader");
      await c.connect(clin2).grantRxAccess(rx, store.address);
      expect(await c.canReadRx(rx, store.address)).to.equal(true);
      await c.connect(clin).revokeRxAccess(rx, store.address);
      expect(await c.canReadRx(rx, store.address)).to.equal(false);
      await c.deactivateClinician(clin2.address);
      expect(await c.canReadRx(rx, clin2.address)).to.equal(false);
      await expect(c.connect(clin2).grantRxAccess(rx, store.address)).to.be.revertedWithCustomError(c, "NotPrescriberOrResponsible");
    });

    it("stores health information only from the responsible clinician, once", async function () {
      const rid = P.randomBytes32();
      await expect(c.connect(clin2).addPhiRecord(rid, pid, P.recordDigest({ d: 1 }))).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await c.connect(clin).addPhiRecord(rid, pid, P.recordDigest({ d: 1 }));
      await expect(c.connect(clin).addPhiRecord(rid, pid, P.recordDigest({ d: 2 }))).to.be.revertedWithCustomError(c, "AlreadyExists");
    });
  });
});
