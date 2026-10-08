"use strict";
/**
 * 2SDIF witness on Azure Functions (Flex Consumption, Node.js 22).
 * App settings (use Key Vault references for the two secrets):
 *   WITNESS_PRIVATE_KEY   @Microsoft.KeyVault(SecretUri=...)   witness signing key held in memory, or
 *   WITNESS_KEY_ID        https://<vault>.vault.azure.net/keys/<name>/<version>  non-exportable P-256K key in
 *                         Key Vault; every attestation is a Key Vault sign operation (managed identity)
 *   DEVICE_KEYS           @Microsoft.KeyVault(SecretUri=...)   JSON {"<did>": "<hex key>", ...}
 *   CHAIN_ID, CONTRACT_ADDRESS                                 deployment the attestations are bound to
 *   WITNESS_TABLE_CONNECTION                                  storage connection string (Table Storage)
 * Routes: POST /api/deposit, GET /api/attestation/{rid}, GET /api/log?since=  (log requires a function key)
 */
const { app } = require("@azure/functions");
const { ethers } = require("ethers");
const { Witness, parseDeviceKeys } = require("../lib/core");
const { TableStore } = require("../tableStore");
const { createKvSigner } = require("../kvSigner");

// One id per worker instance, so that load and cold-start experiments can count instances and tell
// a request served by a fresh instance (x-cold: 1) from one served by a warm instance.
const INSTANCE = require("crypto").randomBytes(4).toString("hex");
const STARTED_AT = Date.now();
let served = 0;

let witnessP = null;
// The witness is built once per instance. With WITNESS_KEY_ID set, attestations are signed by a
// non-exportable key in Key Vault (src/kvSigner.js); otherwise by WITNESS_PRIVATE_KEY held in memory.
function getWitness() {
  if (!witnessP) {
    witnessP = (async () => {
      const signer = process.env.WITNESS_KEY_ID
        ? await createKvSigner(process.env.WITNESS_KEY_ID)
        : new ethers.Wallet(process.env.WITNESS_PRIVATE_KEY);
      const w = new Witness({
        signer,
        deviceKeys: parseDeviceKeys(process.env.DEVICE_KEYS || "{}"),
        store: new TableStore(process.env.WITNESS_TABLE_CONNECTION || process.env.AzureWebJobsStorage),
        chainId: process.env.CHAIN_ID,
        contract: process.env.CONTRACT_ADDRESS,
      });
      w.signerKind = process.env.WITNESS_KEY_ID ? "keyvault" : "memory";
      return w;
    })();
    witnessP.catch(() => { witnessP = null; }); // retry on the next request after a start-up failure
  }
  return witnessP;
}

// x-exec-ms: time spent inside the handler (witness logic + Table Storage), so the client can separate
// the function's own execution time from the network and platform overhead it observes.
function reply(r, t0) {
  served += 1;
  return { status: r.status, jsonBody: r.body, headers: { "x-exec-ms": (performance.now() - t0).toFixed(3), "x-instance": INSTANCE, "x-cold": served === 1 ? "1" : "0" } };
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
    return reply(await (await getWitness()).deposit(body), t0);
  },
});

app.http("attestation", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "attestation/{rid}",
  handler: async (request) => {
    const t0 = performance.now();
    return reply(await (await getWitness()).attestation(request.params.rid), t0);
  },
});

app.http("log", {
  methods: ["GET"],
  authLevel: "function", // auditor presents a function key (x-functions-key header)
  route: "log",
  handler: async (request) => {
    const t0 = performance.now();
    return reply(await (await getWitness()).log(request.query.get("since")), t0);
  },
});

app.http("health", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "health",
  handler: async () => {
    const w = await getWitness();
    served += 1;
    return { jsonBody: { ok: true, witness: w.address, signer: w.signerKind, chainId: String(w.chainId), contract: w.contract, dep: w.dep, instance: INSTANCE, startedAt: STARTED_AT }, headers: { "x-instance": INSTANCE, "x-cold": served === 1 ? "1" : "0" } };
  },
});
