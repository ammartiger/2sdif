"use strict";
/**
 * Deploys the three single-channel baselines (B0, B1, B2), creates a secp256k1 and a P-256 key for the
 * first simulated device, and registers both on chain.
 *   npx hardhat run scripts/deploy-baselines.js --network localhost
 * Writes deployments/baselines_<net>.json (public data) and deployments/baseline_keys_<net>.json
 * (the device's private keys; stays on this machine, deployments/ is not committed).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const hre = require("hardhat");
require("dotenv").config();
const cfg = require("../shared/config");

async function main() {
  const { ethers, network } = hre;
  const [admin] = await ethers.getSigners();
  const gateway = new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY).address;
  const did = cfg.devices()[0].did;
  const deploy = async (name, args) => {
    const c = await (await ethers.getContractFactory(name, admin)).deploy(...args);
    await c.deploymentTransaction().wait();
    return c;
  };
  const b0 = await deploy("TrustedGatewayRegistry", [gateway]);
  const b1 = await deploy("DeviceSignedRegistry", []);
  const b2 = await deploy("DeviceP256Registry", []);

  const secp = ethers.Wallet.createRandom();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const hex = (b64) => "0x" + Buffer.from(b64, "base64url").toString("hex");
  await (await b1.registerDevice(did, secp.address)).wait();
  await (await b2.registerDevice(did, hex(jwk.x), hex(jwk.y))).wait();
  if (network.name !== "sepolia") {
    const bal = await ethers.provider.getBalance(gateway);
    if (bal < ethers.parseEther("10")) await (await admin.sendTransaction({ to: gateway, value: ethers.parseEther("100") })).wait();
  }

  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = { network: network.name, chainId, B0: await b0.getAddress(), B1: await b1.getAddress(), B2: await b2.getAddress(), gateway, did, deviceKeyB1: secp.address, deviceKeyB2: { x: jwk.x, y: jwk.y }, deployedAt: new Date().toISOString() };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `baselines_${network.name}.json`), JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(dir, `baseline_keys_${network.name}.json`), JSON.stringify({ secp256k1: secp.privateKey, p256Pem: privateKey.export({ format: "pem", type: "pkcs8" }) }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
