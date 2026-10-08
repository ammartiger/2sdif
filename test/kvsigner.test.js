const { expect } = require("chai");
const { ethers } = require("ethers");
const { toEthSignature, addressFromJwk } = require("../witness/azure/src/kvSigner");
const P = require("../shared/protocol");

// Key Vault returns ES256K signatures as raw r||s with either s; the witness must turn them into
// low-s Ethereum signatures with the right recovery id, or the contract's ecrecover would reject them.
describe("Key Vault witness signer (signature conversion)", function () {
  const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  const sk = new ethers.SigningKey(ethers.hexlify(ethers.randomBytes(32)));
  const pub = ethers.getBytes(sk.publicKey); // 0x04 || x || y
  const address = ethers.computeAddress(sk.publicKey);

  it("derives the Ethereum address from the JWK coordinates", function () {
    expect(addressFromJwk(pub.slice(1, 33), pub.slice(33))).to.equal(address);
  });

  it("converts low-s and high-s raw signatures into attestations the protocol accepts", async function () {
    for (let i = 0; i < 40; i++) {
      const fields = { chainId: 31337, contract: ethers.Wallet.createRandom().address, did: P.randomBytes32(), seq: BigInt(i), h: P.randomBytes32(), tW: 1700000000 + i };
      const msg = ethers.getBytes(P.attestationMessage(fields));
      const digest = ethers.getBytes(ethers.hashMessage(msg));
      const sig = sk.sign(digest);
      let s = BigInt(sig.s);
      if (i % 2) s = N - s; // emulate a high-s answer
      const raw = Buffer.concat([Buffer.from(ethers.getBytes(sig.r)), Buffer.from(ethers.getBytes(ethers.toBeHex(s, 32)))]);
      const eth = toEthSignature(raw, digest, address);
      expect(P.recoverAttestationSigner(fields, eth)).to.equal(address);
      expect(BigInt(ethers.Signature.from(eth).s) <= N / 2n).to.equal(true);
    }
  });

  it("signs through the Key Vault client API (stubbed) and yields a recoverable attestation", async function () {
    const Module = require("module");
    const orig = Module._resolveFilename;
    const stubs = {
      "@azure/identity": { DefaultAzureCredential: class {} },
      "@azure/keyvault-keys": {
        KeyClient: class { async getKey(name) { return { id: `https://kv.example/keys/${name}/1`, keyType: "EC", key: { crv: "P-256K", x: pub.slice(1, 33), y: pub.slice(33) } }; } },
        CryptographyClient: class {
          async sign(alg, digest) {
            if (alg !== "ES256K") throw new Error("wrong algorithm");
            const g = sk.sign(digest);
            return { result: Buffer.concat([Buffer.from(ethers.getBytes(g.r)), Buffer.from(ethers.getBytes(ethers.toBeHex(N - BigInt(g.s), 32)))]) };
          }
        },
      },
    };
    Module._resolveFilename = function (req, ...rest) { return stubs[req] ? `stub:${req}` : orig.call(this, req, ...rest); };
    for (const [k, v] of Object.entries(stubs)) require.cache[`stub:${k}`] = { id: `stub:${k}`, filename: `stub:${k}`, loaded: true, exports: v };
    try {
      const { createKvSigner } = require("../witness/azure/src/kvSigner");
      const signer = await createKvSigner("https://kv.example/keys/witness-signing/1");
      expect(signer.address).to.equal(address);
      const fields = { chainId: 1, contract: address, did: P.randomBytes32(), seq: 7n, h: P.randomBytes32(), tW: 1 };
      expect(P.recoverAttestationSigner(fields, await P.signAttestation(signer, fields))).to.equal(address);
    } finally {
      Module._resolveFilename = orig;
    }
  });

  it("refuses a signature by another key", function () {
    const other = new ethers.SigningKey(ethers.hexlify(ethers.randomBytes(32)));
    const digest = ethers.getBytes(ethers.hashMessage("x"));
    const sig = other.sign(digest);
    const raw = Buffer.concat([Buffer.from(ethers.getBytes(sig.r)), Buffer.from(ethers.getBytes(sig.s))]);
    expect(() => toEthSignature(raw, digest, address)).to.throw(/does not recover/);
  });
});
