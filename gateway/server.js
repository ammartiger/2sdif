"use strict";
/**
 * Fog gateway entry point.  Env: NETWORK (localhost|sepolia), GATEWAY_PRIVATE_KEY, WITNESS_URL,
 * GATEWAY_PORT (default 3001), DATA_DIR (default ./data), POLL_MS (receipt polling interval),
 * KEEPALIVE_MS (HTTP connection reuse, see shared/http.js).
 * Omission experiments only: FAULT_WITHHOLD_EVERY=n (never commit every n-th record),
 * FAULT_DELAY_EVERY=m and FAULT_DELAY_MS (commit every m-th record late).
 */
const path = require("path");
const { ethers } = require("ethers");
const cfg = require("../shared/config");
const { createGateway } = require("./app");
const { JsonStore } = require("./store");
const { configureHttp } = require("../shared/http");

async function main() {
  configureHttp();
  const net = cfg.network();
  const dep = cfg.deployment(net);
  const pollingInterval = Number(process.env.POLL_MS || (net === "sepolia" ? 1000 : 10));
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl(net), undefined, { pollingInterval, cacheTimeout: -1 });
  const wallet = new ethers.NonceManager(new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY, provider));
  const artifact = require("../artifacts/contracts/TwoSDIFRegistry.sol/TwoSDIFRegistry.json");
  const contract = new ethers.Contract(dep.address, artifact.abi, wallet);
  const witnessAddress = await contract.witness();
  const app = createGateway({
    contract,
    witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api").replace(/\/$/, ""),
    witnessAddress,
    chainId: dep.chainId,
    store: new JsonStore(process.env.DATA_DIR || path.join(cfg.ROOT, "data", net)),
    domain: process.env.GATEWAY_DOMAIN || "localhost",
    log: console.log,
    receiptSigner: wallet,
    fault: {
      withholdEvery: Number(process.env.FAULT_WITHHOLD_EVERY || 0),
      delayEvery: Number(process.env.FAULT_DELAY_EVERY || 0),
      delayMs: Number(process.env.FAULT_DELAY_MS || 0),
    },
  });
  const port = Number(process.env.GATEWAY_PORT || 3001);
  app.listen(port, () => console.log(`[gateway] ${net} on http://127.0.0.1:${port}  contract ${dep.address}  witness ${witnessAddress}`));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
