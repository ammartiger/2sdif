"use strict";
/** Serves the web app and a /config.json derived from the current deployment.  npm run web */
const path = require("path");
const express = require("express");
const cfg = require("../shared/config");

const net = cfg.network();
const dep = cfg.deployment(net);
const artifact = require("../artifacts/contracts/TwoSDIFRegistry.sol/TwoSDIFRegistry.json");
const app = express();
app.get("/config.json", (_req, res) =>
  res.json({
    network: net,
    chainId: dep.chainId,
    contract: dep.address,
    abi: artifact.abi,
    gatewayUrl: process.env.PUBLIC_GATEWAY_URL || process.env.GATEWAY_URL || "http://127.0.0.1:3001",
    pidSalt: process.env.PID_SALT || "2sdif-demo-salt",
  })
);
app.use(express.static(__dirname));
const port = Number(process.env.WEB_PORT || 8080);
app.listen(port, () => console.log(`[web] http://127.0.0.1:${port}  (${net}, contract ${dep.address})`));
