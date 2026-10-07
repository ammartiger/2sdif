const { expect } = require("chai");
const { ethers } = require("hardhat");
const P = require("../shared/protocol");

describe("TwoSDIFRegistry (contract level)", function () {
  let c, admin, clin, clin2, doc, patient, store, outsider, gw, witness, chainId, pid;

  beforeEach(async function () {
    [admin, clin, clin2, doc, patient, store, outsider, gw] = await ethers.getSigners();
    witness = ethers.Wallet.createRandom();
    c = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witness.address);
    chainId = (await ethers.provider.getNetwork()).chainId;
    pid = P.toBytes32Id("patient-01");
    await c.registerClinician(clin.address, P.recordDigest({ n: "clin" }));
    await c.registerClinician(clin2.address, P.recordDigest({ n: "clin2" }));
    await c.registerPatient(pid, patient.address, clin.address, P.recordDigest({ n: "p" }));
  });

  async function attest(fields, signer = witness) {
    const full = { chainId, contract: await c.getAddress(), tW: Math.floor(Date.now() / 1000), ...fields };
    return { full, sig: await P.signAttestation(signer, full) };
  }

  describe("attested commitments", function () {
    it("accepts a digest attested by the registered witness, from any submitter", async function () {
      const { full, sig } = await attest({ rid: P.randomBytes32(), h: P.recordDigest({ a: 1 }), did: P.toBytes32Id("s1") });
      await expect(c.connect(gw).commitProof(full.rid, full.h, full.did, full.tW, sig)).to.emit(c, "ProofCommitted");
      const p = await c.getProof(full.rid);
      expect(p.digest).to.equal(full.h);
    });

    it("matches the off-chain attestation message", async function () {
      const f = { rid: P.randomBytes32(), h: P.recordDigest({ a: 2 }), did: P.toBytes32Id("s1"), tW: 123 };
      const onchain = await c.attestationMessage(f.rid, f.h, f.did, f.tW);
      expect(onchain).to.equal(P.attestationMessage({ chainId, contract: await c.getAddress(), ...f }));
    });

    it("rejects an altered digest carrying a valid attestation for the original (gateway substitution)", async function () {
      const { full, sig } = await attest({ rid: P.randomBytes32(), h: P.recordDigest({ a: 1 }), did: P.toBytes32Id("s1") });
      await expect(c.connect(gw).commitProof(full.rid, P.recordDigest({ a: 999 }), full.did, full.tW, sig)).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("rejects an attestation signed by anyone other than the witness", async function () {
      const { full, sig } = await attest({ rid: P.randomBytes32(), h: P.recordDigest({ a: 1 }), did: P.toBytes32Id("s1") }, ethers.Wallet.createRandom());
      await expect(c.connect(gw).commitProof(full.rid, full.h, full.did, full.tW, sig)).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("rejects malformed signatures", async function () {
      await expect(c.commitProof(P.randomBytes32(), P.recordDigest({ a: 1 }), P.toBytes32Id("s1"), 1, "0x1234")).to.be.revertedWithCustomError(c, "InvalidAttestation");
    });

    it("is write once per record id", async function () {
      const { full, sig } = await attest({ rid: P.randomBytes32(), h: P.recordDigest({ a: 1 }), did: P.toBytes32Id("s1") });
      await c.commitProof(full.rid, full.h, full.did, full.tW, sig);
      await expect(c.commitProof(full.rid, full.h, full.did, full.tW, sig)).to.be.revertedWithCustomError(c, "AlreadyCommitted");
    });

    it("rejects an attestation replayed on a second deployment", async function () {
      const { full, sig } = await attest({ rid: P.randomBytes32(), h: P.recordDigest({ a: 1 }), did: P.toBytes32Id("s1") });
      const c2 = await (await ethers.getContractFactory("TwoSDIFRegistry", admin)).deploy(witness.address);
      await expect(c2.commitProof(full.rid, full.h, full.did, full.tW, sig)).to.be.revertedWithCustomError(c2, "InvalidAttestation");
    });

    it("lets only the administrator rotate the witness", async function () {
      await expect(c.connect(outsider).setWitness(outsider.address)).to.be.revertedWithCustomError(c, "NotAdmin");
      await expect(c.setWitness(outsider.address)).to.emit(c, "WitnessChanged");
    });
  });

  describe("access control", function () {
    it("lets only the administrator register participants", async function () {
      await expect(c.connect(outsider).registerClinician(outsider.address, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "NotAdmin");
      await expect(c.connect(outsider).registerPatient(P.toBytes32Id("x"), outsider.address, clin.address, ethers.ZeroHash)).to.be.revertedWithCustomError(c, "NotAdmin");
    });

    it("lets only the responsible clinician grant and revoke PHI access", async function () {
      await expect(c.connect(outsider).grantPhiAccess(pid, outsider.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await expect(c.connect(clin2).grantPhiAccess(pid, clin2.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      expect(await c.canReadPhi(pid, doc.address)).to.equal(false);
      await c.connect(clin).grantPhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(true);
      await c.connect(clin).revokePhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(false);
    });

    it("moves ACL authority when the administrator reassigns the clinician", async function () {
      await c.reassignClinician(pid, clin2.address);
      await expect(c.connect(clin).grantPhiAccess(pid, doc.address)).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await c.connect(clin2).grantPhiAccess(pid, doc.address);
      expect(await c.canReadPhi(pid, doc.address)).to.equal(true);
    });

    it("gives patients and responsible clinicians read access by default", async function () {
      expect(await c.canReadPhi(pid, patient.address)).to.equal(true);
      expect(await c.canReadPhi(pid, clin.address)).to.equal(true);
      expect(await c.canReadPhi(pid, outsider.address)).to.equal(false);
    });

    it("enforces prescription rules (prescriber, responsible clinician, store only if granted)", async function () {
      const rx = P.randomBytes32();
      await expect(c.connect(outsider).addPrescription(rx, pid, P.recordDigest({ r: 1 }))).to.be.revertedWithCustomError(c, "NotClinician");
      await c.connect(clin2).addPrescription(rx, pid, P.recordDigest({ r: 1 }));
      expect(await c.canReadRx(rx, clin2.address)).to.equal(true); // prescriber
      expect(await c.canReadRx(rx, clin.address)).to.equal(true); // responsible clinician
      expect(await c.canReadRx(rx, store.address)).to.equal(false);
      await expect(c.connect(outsider).grantRxAccess(rx, store.address)).to.be.revertedWithCustomError(c, "NotPrescriberOrResponsible");
      await c.connect(clin2).grantRxAccess(rx, store.address);
      expect(await c.canReadRx(rx, store.address)).to.equal(true);
      await c.connect(clin).revokeRxAccess(rx, store.address);
      expect(await c.canReadRx(rx, store.address)).to.equal(false);
    });

    it("stores health information only from the responsible clinician, once", async function () {
      const rid = P.randomBytes32();
      await expect(c.connect(clin2).addPhiRecord(rid, pid, P.recordDigest({ d: 1 }))).to.be.revertedWithCustomError(c, "NotResponsibleClinician");
      await c.connect(clin).addPhiRecord(rid, pid, P.recordDigest({ d: 1 }));
      await expect(c.connect(clin).addPhiRecord(rid, pid, P.recordDigest({ d: 2 }))).to.be.revertedWithCustomError(c, "AlreadyExists");
    });
  });
});
