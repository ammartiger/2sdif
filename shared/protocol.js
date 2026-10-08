"use strict";
/**
 * 2SDIF protocol helpers shared by the device, witness, gateway, auditor and tests.
 *
 *  - canonicalize():       deterministic JSON (keys sorted recursively, no whitespace)
 *  - recordDigest():       SHA-256 over the canonical record, as bytes32 hex
 *  - recordId():           rid = keccak256(abi.encode(did, seq)) -- identical to TwoSDIFRegistry.recordId()
 *  - deploymentId():       dep = keccak256(abi.encode(chainId, contract))
 *  - deviceTag():          HMAC-SHA256 over (did | seq | h | t | dep) with the device key
 *  - attestationMessage(): keccak256(abi.encode("2SDIF-v2", chainId, contract, did, seq, h, tW))
 *                          -- identical to TwoSDIFRegistry.attestationMessage()
 *  - signAttestation() / recoverAttestationSigner(): EIP-191 personal_sign over that message
 *  - receiptMessage():     keccak256(abi.encode("2SDIF-receipt", chainId, contract, rid, h)), signed by the gateway
 */
const crypto = require("crypto");
const { ethers } = require("ethers");

const DOMAIN_TAG = "2SDIF-v2";
const RECEIPT_TAG = "2SDIF-receipt";
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
}

function sha256Hex(data) {
  return "0x" + crypto.createHash("sha256").update(data).digest("hex");
}

/** SHA-256 digest of the canonical form of a record (bytes32 hex). */
function recordDigest(record) {
  return sha256Hex(Buffer.from(canonicalize(record), "utf8"));
}

function isBytes32(x) {
  return typeof x === "string" && BYTES32_RE.test(x);
}

/** Map a human-readable identifier to bytes32 (keccak256 of UTF-8); bytes32 inputs pass through. */
function toBytes32Id(x) {
  if (isBytes32(x)) return x.toLowerCase();
  return ethers.keccak256(ethers.toUtf8Bytes(String(x)));
}

function randomBytes32() {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

function randomNonceHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
}

const abi = ethers.AbiCoder.defaultAbiCoder();

/** Device-bound record identifier; must match TwoSDIFRegistry.recordId(). */
function recordId(did, seq) {
  return ethers.keccak256(abi.encode(["bytes32", "uint64"], [did, BigInt(seq)])).toLowerCase();
}

/** Identifier of a deployment (chain and contract) that a deposit is meant for. */
function deploymentId(chainId, contract) {
  return ethers.keccak256(abi.encode(["uint256", "address"], [BigInt(chainId), contract])).toLowerCase();
}

function tagInput({ did, seq, h, t, dep }) {
  return `${String(did).toLowerCase()}|${BigInt(seq).toString()}|${String(h).toLowerCase()}|${Number(t)}|${String(dep).toLowerCase()}`;
}

/** HMAC-SHA256 tag the device attaches to its deposit (hex, no 0x). */
function deviceTag(keyHex, fields) {
  const key = Buffer.from(keyHex.replace(/^0x/, ""), "hex");
  return crypto.createHmac("sha256", key).update(tagInput(fields)).digest("hex");
}

function verifyDeviceTag(keyHex, fields, tagHex) {
  if (typeof tagHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(tagHex)) return false;
  const expected = Buffer.from(deviceTag(keyHex, fields), "hex");
  const got = Buffer.from(tagHex, "hex");
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

/** Must match TwoSDIFRegistry.attestationMessage(). */
function attestationMessage({ chainId, contract, did, seq, h, tW }) {
  return ethers.keccak256(
    abi.encode(
      ["string", "uint256", "address", "bytes32", "uint64", "bytes32", "uint64"],
      [DOMAIN_TAG, BigInt(chainId), contract, did, BigInt(seq), h, BigInt(tW)]
    )
  );
}

async function signAttestation(wallet, fields) {
  return wallet.signMessage(ethers.getBytes(attestationMessage(fields)));
}

function recoverAttestationSigner(fields, signature) {
  return ethers.verifyMessage(ethers.getBytes(attestationMessage(fields)), signature);
}

/** Gateway receipt: proves the gateway accepted record rid with digest h on channel 1. */
function receiptMessage({ chainId, contract, rid, h }) {
  return ethers.keccak256(abi.encode(["string", "uint256", "address", "bytes32", "bytes32"], [RECEIPT_TAG, BigInt(chainId), contract, rid, h]));
}

async function signReceipt(wallet, fields) {
  return wallet.signMessage(ethers.getBytes(receiptMessage(fields)));
}

function recoverReceiptSigner(fields, signature) {
  return ethers.verifyMessage(ethers.getBytes(receiptMessage(fields)), signature);
}

/** Sign-In-with-Ethereum style login message (EIP-4361 inspired). */
function loginMessage({ domain, address, nonce, issuedAt, expiresAt, chainId }) {
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    "",
    "Sign in to the 2SDIF fog gateway.",
    "",
    `URI: https://${domain}`,
    "Version: 1",
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

module.exports = {
  DOMAIN_TAG,
  RECEIPT_TAG,
  canonicalize,
  sha256Hex,
  recordDigest,
  isBytes32,
  toBytes32Id,
  randomBytes32,
  randomNonceHex,
  recordId,
  deploymentId,
  deviceTag,
  verifyDeviceTag,
  attestationMessage,
  signAttestation,
  recoverAttestationSigner,
  receiptMessage,
  signReceipt,
  recoverReceiptSigner,
  loginMessage,
  nowMs,
};
