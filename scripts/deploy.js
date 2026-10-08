"use strict";
/**
 * Deploys TwoSDIFRegistry bound to the witness address and records the deployment.
 *   npx hardhat run scripts/deploy.js --network localhost|sepolia
 * On localhost it also funds the gateway account from the default Hardhat account.
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
require("dotenv").config();

async function main() {
  const { ethers, network } = hre;
  const [admin] = await ethers.getSigners();
  const witness = process.env.WITNESS_ADDRESS || new ethers.Wallet(process.env.WITNESS_PRIVATE_KEY).address;
  const gateway = new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY).address;

  // On Sepolia use the provider's suggested priority fee (fees there are tiny) instead of a 1 gwei default.
  let fee = {};
  if (network.name === "sepolia") {
    const tip = BigInt(await ethers.provider.send("eth_maxPriorityFeePerGas", []));
    const base = (await ethers.provider.getBlock("latest")).baseFeePerGas || 0n;
    fee = { maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip };
  }
  const witnessDelay = BigInt(process.env.WITNESS_DELAY_SEC || 86400); // announced witness rotation delay
  const Factory = await ethers.getContractFactory("TwoSDIFRegistry", admin);
  const c = await Factory.deploy(witness, witnessDelay, fee);
  const rc = await c.deploymentTransaction().wait();
  const address = await c.getAddress();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  if (network.name !== "sepolia") {
    await (await admin.sendTransaction({ to: gateway, value: ethers.parseEther("100") })).wait();
  }

  const out = { network: network.name, chainId, address, witness, admin: admin.address, gateway, witnessDelay: witnessDelay.toString(), block: rc.blockNumber, deployGas: rc.gasUsed.toString(), deployTx: rc.hash, deployedAt: new Date().toISOString() };
  const dir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${network.name}.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
