"use strict";
/**
 * Local witness emulator: same logic and routes as the Azure Functions witness,
 * with an in-memory write-once store. Useful for dry runs and for the attack suite.
 *   npm run witness:local
 */
const { ethers } = require("ethers");
const cfg = require("../shared/config");
const { Witness, MemoryStore, parseDeviceKeys } = require("./core");
const { createWitnessApp } = require("./app");

function main() {
  const dep = cfg.deployment();
  const keys = {};
  for (const d of cfg.devices()) keys[d.did] = d.key;
  const witness = new Witness({
    signer: new ethers.Wallet(process.env.WITNESS_PRIVATE_KEY),
    deviceKeys: parseDeviceKeys(keys),
    store: new MemoryStore(),
    chainId: dep.chainId,
    contract: dep.address,
  });
  const port = Number(process.env.WITNESS_PORT || 7071);
  createWitnessApp(witness, { auditorKey: process.env.AUDITOR_KEY }).listen(port, () =>
    console.log(`[witness] local emulator on http://127.0.0.1:${port}/api  (witness ${witness.address})`)
  );
}

if (require.main === module) main();
