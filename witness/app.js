"use strict";
/** Express wrapper around the witness core (local emulator; same routes as the Azure Functions app). */
const express = require("express");

function createWitnessApp(witness, { auditorKey } = {}) {
  const app = express();
  app.use(express.json({ limit: "16kb" }));

  // x-exec-ms mirrors the Azure Functions app: time spent inside the handler
  let served = 0;
  app.use((_req, res, next) => {
    const t0 = performance.now();
    served += 1;
    res.set("x-instance", "local");
    res.set("x-cold", served === 1 ? "1" : "0");
    const json = res.json.bind(res);
    res.json = (body) => { res.set("x-exec-ms", (performance.now() - t0).toFixed(3)); return json(body); };
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, witness: witness.address, chainId: String(witness.chainId), contract: witness.contract, dep: witness.dep, instance: "local" }));

  app.post("/api/deposit", async (req, res) => {
    const r = await witness.deposit(req.body);
    res.status(r.status).json(r.body);
  });

  app.get("/api/attestation/:rid", async (req, res) => {
    const r = await witness.attestation(req.params.rid);
    res.status(r.status).json(r.body);
  });

  app.get("/api/log", async (req, res) => {
    const key = req.get("x-auditor-key") || req.get("x-functions-key");
    if (!auditorKey || key !== auditorKey) return res.status(401).json({ error: "auditor key required" });
    const r = await witness.log(req.query.since);
    res.status(r.status).json(r.body);
  });

  return app;
}

module.exports = { createWitnessApp };
