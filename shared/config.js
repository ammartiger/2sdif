"use strict";
/** Loads .env, devices.json and deployments/<network>.json for the Node components. */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const ROOT = path.join(__dirname, "..");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function network() {
  return process.env.NETWORK || "localhost";
}

function deployment(net = network()) {
  const d = readJson(path.join(ROOT, "deployments", `${net}.json`), null);
  if (!d) throw new Error(`No deployment for network "${net}". Run the deploy script first.`);
  return d;
}

function devices() {
  const file = process.env.DEVICES_FILE || path.join(ROOT, "devices.json");
  const d = readJson(file, null);
  if (!d) throw new Error(`No devices file at ${file}. Run "npm run keys" first.`);
  return d.devices;
}

function rpcUrl(net = network()) {
  if (net === "sepolia") return process.env.SEPOLIA_RPC_URL;
  return process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545";
}

module.exports = { ROOT, readJson, network, deployment, devices, rpcUrl };
