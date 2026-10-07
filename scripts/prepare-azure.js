"use strict";
/** Copies the shared protocol and witness core into the Azure Functions package before deployment. */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const dst = path.join(root, "witness", "azure", "src");
fs.mkdirSync(path.join(dst, "shared"), { recursive: true });
fs.mkdirSync(path.join(dst, "lib"), { recursive: true });
fs.copyFileSync(path.join(root, "shared", "protocol.js"), path.join(dst, "shared", "protocol.js"));
fs.copyFileSync(path.join(root, "witness", "core.js"), path.join(dst, "lib", "core.js"));
console.log("[prepare-azure] copied shared/protocol.js and witness/core.js into witness/azure/src");
