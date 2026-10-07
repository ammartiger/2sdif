"use strict";
/**
 * 2SDIF witness on Azure Functions (Flex Consumption, Node.js 22).
 * App settings (use Key Vault references for the two secrets):
 *   WITNESS_PRIVATE_KEY   @Microsoft.KeyVault(SecretUri=...)   witness signing key
 *   DEVICE_KEYS           @Microsoft.KeyVault(SecretUri=...)   JSON {"<did>": "<hex key>", ...}
 *   CHAIN_ID, CONTRACT_ADDRESS                                 deployment the attestations are bound to
 *   WITNESS_TABLE_CONNECTION                                  storage connection string (Table Storage)
 * Routes: POST /api/deposit, GET /api/attestation/{rid}, GET /api/log?since=  (log requires a function key)
 */
const { app } = require("@azure/functions");
const { ethers } = require("ethers");
const { Witness, parseDeviceKeys } = require("../lib/core");
const { TableStore } = require("../tableStore");

let witness;
function getWitness() {
  if (!witness) {
    witness = new Witness({
      signer: new ethers.Wallet(process.env.WITNESS_PRIVATE_KEY),
      deviceKeys: parseDeviceKeys(process.env.DEVICE_KEYS || "{}"),
      store: new TableStore(process.env.WITNESS_TABLE_CONNECTION || process.env.AzureWebJobsStorage),
      chainId: process.env.CHAIN_ID,
      contract: process.env.CONTRACT_ADDRESS,
    });
  }
  return witness;
}

// x-exec-ms: time spent inside the handler (witness logic + Table Storage), so the client can separate
// the function's own execution time from the network and platform overhead it observes.
function reply(r, t0) {
  return { status: r.status, jsonBody: r.body, headers: { "x-exec-ms": (performance.now() - t0).toFixed(3) } };
}

app.http("deposit", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "deposit",
  handler: async (request) => {
    const t0 = performance.now();
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "invalid JSON" } };
    }
    return reply(await getWitness().deposit(body), t0);
  },
});

app.http("attestation", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "attestation/{rid}",
  handler: async (request) => {
    const t0 = performance.now();
    return reply(await getWitness().attestation(request.params.rid), t0);
  },
});

app.http("log", {
  methods: ["GET"],
  authLevel: "function", // auditor presents a function key (x-functions-key header)
  route: "log",
  handler: async (request) => {
    const t0 = performance.now();
    return reply(await getWitness().log(request.query.get("since")), t0);
  },
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const w = getWitness();
    return { jsonBody: { ok: true, witness: w.address, chainId: String(w.chainId), contract: w.contract } };
  },
});
