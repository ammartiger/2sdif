"use strict";
/**
 * Headless end-to-end test of the web app (Playwright + Chromium).
 * MetaMask is replaced by a minimal EIP-1193 provider that forwards to the local Hardhat node's unlocked
 * accounts, so every signature and transaction really goes through the chain and the gateway.
 * Requires: chain, witness, gateway and `npm run web` running on localhost; `npm i --no-save playwright`.
 *   node scripts/check-web.js [--screenshot results/web_e2e.png]
 */
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const cfg = require("../shared/config");
const P = require("../shared/protocol");
const { Device } = require("../device/device");

const WEB = process.env.WEB_URL || "http://127.0.0.1:8080";
const RPC = cfg.rpcUrl("localhost");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function main() {
  const accounts = await rpc("eth_accounts", []);
  const [admin, clinician, doctor, patient, store, outsider] = accounts;
  const results = [];
  const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); };

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const ethersUmd = fs.readFileSync(path.join(cfg.ROOT, "node_modules", "ethers", "dist", "ethers.umd.min.js"), "utf8");
  await page.route(/cdnjs\.cloudflare\.com\/.*ethers.*\.js$/, (route) => route.fulfill({ contentType: "application/javascript", body: ethersUmd }));
  let current = admin;
  await page.exposeFunction("__rpc", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [current];
    return rpc(method, params);
  });
  await page.addInitScript(() => {
    window.ethereum = {
      isMetaMask: true,
      request: ({ method, params }) => window.__rpc(method, params || []),
      on() {}, removeListener() {},
    };
  });
  const logText = () => page.locator("#log").innerText();
  const waitLog = async (re, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (re.test(await logText())) return true; await page.waitForTimeout(100); }
    return false;
  };
  async function signInAs(addr) {
    current = addr;
    await page.goto(WEB);
    await page.click("#btnConnect");
    return waitLog(new RegExp(`signed in as ${addr}`, "i"));
  }
  const click = (action) => page.click(`button[data-action="${action}"]`);
  const fill = (id, v) => page.fill(`#${id}`, v);

  // 1. administrator registers a clinician and a patient
  check("administrator signs in (nonce + signature, no transaction)", await signInAs(admin));
  await fill("clinAddr", clinician); await fill("clinName", "Dr Test"); await fill("clinPhone", "000"); await fill("clinNid", "C-1");
  await click("registerClinician");
  check("administrator registers a clinician and stores the record at the fog", await waitLog(/clinician record stored at the fog/));
  const device = cfg.devices()[0];
  await fill("patNid", device.nationalId); await fill("patAddr", patient); await fill("patClin", clinician); await fill("patName", "Patient Test"); await fill("patContact", "Islamabad");
  await click("registerPatient");
  check("administrator registers the patient monitored by sensor-01", await waitLog(new RegExp(`patient ${device.pid} stored`, "i")));

  // 2. outsider cannot change the ACL, even from the UI
  check("outsider signs in", await signInAs(outsider));
  await fill("phiNid", device.nationalId); await fill("phiReader", outsider);
  await click("grantPhi");
  check("outsider's attempt to grant itself access is reverted by the contract", await waitLog(/NotResponsibleClinician|revert|execution reverted/i));

  // 3. responsible clinician adds health information and grants a doctor
  check("clinician signs in", await signInAs(clinician));
  await fill("phiNid", device.nationalId); await fill("phiDx", "hypertension"); await fill("phiPlan", "annual"); await fill("phiPay", "insurance");
  await click("addPhi");
  check("clinician commits and stores a health information record", await waitLog(/health information 0x[0-9a-f]{64} stored/i));
  const rid = await page.inputValue("#readId");
  await fill("phiReader", doctor);
  await click("grantPhi");
  check("clinician grants the doctor access", await waitLog(/grantPhiAccess: included/));

  // 4. doctor reads and verifies; after revocation access is denied
  check("doctor signs in", await signInAs(doctor));
  await fill("readId", rid);
  await click("readPhi");
  check("doctor reads the record and it verifies against the chain", await waitLog(/read 0x[0-9a-f]{64}: verified/i));
  check("clinician signs in again", await signInAs(clinician));
  await fill("phiNid", device.nationalId); await fill("phiReader", doctor);
  await click("revokePhi");
  check("clinician revokes the doctor's access", await waitLog(/revokePhiAccess: included/));
  check("doctor signs in again", await signInAs(doctor));
  await fill("readId", rid);
  await click("readPhi");
  check("revoked doctor is denied (403 AccessDenied)", await waitLog(/403 AccessDenied/));

  // 5. prescription path with a medical store
  check("clinician signs in for prescriptions", await signInAs(clinician));
  await fill("rxNid", device.nationalId); await fill("rxDx", "hypertension"); await fill("rxText", "amlodipine 5 mg");
  await click("addRx");
  check("clinician commits and stores a prescription", await waitLog(/prescription 0x[0-9a-f]{64} stored/i));
  const rxId = await page.inputValue("#rxId");
  // medical store must be registered by the admin first (contract role); access is granted per prescription
  await fill("rxReader", store);
  await click("grantRx");
  check("prescriber grants the medical store access", await waitLog(/grantRxAccess: included/));
  check("medical store signs in", await signInAs(store));
  await fill("readId", rxId);
  await click("readRx");
  check("medical store reads the prescription and it verifies", await waitLog(/read 0x[0-9a-f]{64}: verified/i));

  // 6. device record through the dual channel, read by the patient in the browser
  const d0 = cfg.deployment();
  const dev = new Device({ ...device, dep: P.deploymentId(d0.chainId, d0.address) });
  const r = await dev.submit(dev.makeReading(), { witnessUrl: (process.env.WITNESS_URL || "http://127.0.0.1:7071/api"), gatewayUrl: "http://127.0.0.1:3001" });
  check("sensor-01 stores a reading through the dual channel", r.ok);
  check("patient signs in", await signInAs(patient));
  await fill("readId", r.rid);
  await click("readDevice");
  check("patient reads the device record and it verifies against the attested proof", await waitLog(/read 0x[0-9a-f]{64}: verified/i));

  const shot = arg("screenshot", path.join(cfg.ROOT, "results", "web_e2e.png"));
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await page.screenshot({ path: shot, fullPage: true });
  await browser.close();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} web checks passed (screenshot: ${shot})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
