"use strict";
/**
 * Witness signer backed by a non-exportable secp256k1 key in Azure Key Vault (key type EC, curve P-256K).
 * The private key never enters the function: each attestation is an ES256K sign operation in Key Vault,
 * authorized by the Function App's managed identity. The result is converted to an Ethereum signature
 * (low-s, recovery id), so the contract verifies it with ecrecover exactly like an in-memory key's.
 * Enabled by the app setting WITNESS_KEY_ID (the key identifier, https://<vault>.vault.azure.net/keys/<name>/<version>).
 */
const { ethers } = require("ethers");

const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"); // secp256k1 group order

/** r||s (64 bytes) from Key Vault -> 65-byte Ethereum signature over `digest` that recovers to `address`. */
function toEthSignature(raw, digest, address) {
  const bytes = Buffer.from(raw);
  if (bytes.length !== 64) throw new Error(`unexpected signature length ${bytes.length}`);
  const r = "0x" + bytes.subarray(0, 32).toString("hex");
  let s = BigInt("0x" + bytes.subarray(32).toString("hex"));
  if (s > N / 2n) s = N - s; // OpenZeppelin ECDSA (and EIP-2) accept only low-s signatures
  const sHex = ethers.toBeHex(s, 32);
  for (const v of [27, 28]) {
    const sig = ethers.Signature.from({ r, s: sHex, v });
    if (ethers.recoverAddress(digest, sig).toLowerCase() === address.toLowerCase()) return sig.serialized;
  }
  throw new Error("Key Vault signature does not recover to the witness address");
}

function addressFromJwk(x, y) {
  return ethers.computeAddress("0x04" + Buffer.from(x).toString("hex") + Buffer.from(y).toString("hex"));
}

async function createKvSigner(keyId, { credential } = {}) {
  const { DefaultAzureCredential } = require("@azure/identity");
  const { KeyClient, CryptographyClient } = require("@azure/keyvault-keys");
  const cred = credential || new DefaultAzureCredential();
  const u = new URL(keyId);
  const [, , name, version] = u.pathname.split("/");
  const key = await new KeyClient(`${u.protocol}//${u.host}`, cred).getKey(name, version || undefined);
  if (key.keyType !== "EC" || key.key.crv !== "P-256K") throw new Error(`witness key must be EC P-256K, got ${key.keyType} ${key.key.crv}`);
  const address = addressFromJwk(key.key.x, key.key.y);
  const client = new CryptographyClient(key.id, cred);
  return {
    address,
    kind: "keyvault",
    // same contract as ethers.Wallet#signMessage: EIP-191 personal message over the given bytes
    async signMessage(message) {
      const digest = ethers.getBytes(ethers.hashMessage(message));
      const { result } = await client.sign("ES256K", digest);
      return toEthSignature(result, digest, address);
    },
  };
}

module.exports = { createKvSigner, toEthSignature, addressFromJwk };
