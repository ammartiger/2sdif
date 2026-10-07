"use strict";
/**
 * Generates the keys the prototype needs, without overwriting existing ones:
 *   .env          WITNESS_PRIVATE_KEY, GATEWAY_PRIVATE_KEY, AUDITOR_KEY (+ placeholders for Sepolia)
 *   devices.json  N simulated sensors: label, did (bytes32), HMAC key (256 bit), patient id
 * Usage: node scripts/gen-keys.js [--devices 10]
 * Keys stay on this machine. Never commit .env or devices.json.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const P = require("../shared/protocol");

const root = path.join(__dirname, "..");
const envFile = path.join(root, ".env");
const devFile = path.join(root, "devices.json");
const nArg = process.argv.indexOf("--devices");
const nDevices = nArg > 0 ? Number(process.argv[nArg + 1]) : 10;

if (!fs.existsSync(envFile)) {
  const lines = [
    "# 2SDIF prototype configuration (generated). Do NOT commit this file.",
    "NETWORK=localhost",
    `WITNESS_PRIVATE_KEY=${ethers.Wallet.createRandom().privateKey}`,
    `GATEWAY_PRIVATE_KEY=${ethers.Wallet.createRandom().privateKey}`,
    `AUDITOR_KEY=${crypto.randomBytes(24).toString("hex")}`,
    "",
    "# Local chain: the deploy script funds the gateway from the Hardhat default account.",
    "LOCAL_RPC_URL=http://127.0.0.1:8545",
    "",
    "# Sepolia (fill in; use a throwaway wallet funded from a faucet)",
    "SEPOLIA_RPC_URL=",
    "ADMIN_PRIVATE_KEY=",
    "",
    "# Witness endpoint: local emulator by default, Azure after deployment",
    "WITNESS_URL=http://127.0.0.1:7071/api",
    "GATEWAY_URL=http://127.0.0.1:3001",
  ];
  fs.writeFileSync(envFile, lines.join("\n") + "\n");
  console.log("[keys] wrote .env");
} else {
  console.log("[keys] .env exists, left unchanged");
}

if (!fs.existsSync(devFile)) {
  const devices = [];
  for (let i = 1; i <= nDevices; i++) {
    const label = `sensor-${String(i).padStart(2, "0")}`;
    devices.push({
      label,
      did: P.toBytes32Id(label),
      key: crypto.randomBytes(32).toString("hex"),
      // pseudonymous patient id = keccak256("<PID_SALT>:<national id>"), same rule as the web app;
      // the synthetic national id of the patient this sensor monitors is "patient-XX"
      nationalId: `patient-${String(i).padStart(2, "0")}`,
      pid: ethers.keccak256(ethers.toUtf8Bytes(`${process.env.PID_SALT || "2sdif-demo-salt"}:patient-${String(i).padStart(2, "0")}`)),
    });
  }
  fs.writeFileSync(devFile, JSON.stringify({ devices }, null, 2));
  console.log(`[keys] wrote devices.json with ${nDevices} devices`);
} else {
  console.log("[keys] devices.json exists, left unchanged");
}
