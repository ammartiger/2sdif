#!/usr/bin/env node
"use strict";
/**
 * Azure deployment and benchmark orchestration for the 2SDIF witness.
 * Runs on the fog-node machine (Windows, Linux or macOS) with Node.js and the Azure CLI (`az login` done first).
 *
 *   node scripts/azure.js preflight        subscription, allowed regions (policy) and Flex Consumption regions; picks a region
 *   node scripts/azure.js deploy           resource group, storage account, Key Vault, Function App (Flex Consumption), witness code
 *   node scripts/azure.js bench            local chain + gateway on this machine, witness on Azure; writes results/
 *   node scripts/azure.js sepolia-wallet   create (if needed) the throwaway Sepolia admin wallet and show its address/balance
 *   node scripts/azure.js sepolia          Sepolia commit latency (funded ADMIN_PRIVATE_KEY; SEPOLIA_RPC_URL optional)
 *   node scripts/azure.js status           show the deployment and the witness health
 *   node scripts/azure.js teardown         delete the resource group and purge the Key Vault
 *
 * Options: --log <file>      append a copy of all output (UTF-8)
 *          --copy-to <dir>   copy results/ there when a step finishes
 *          --region <name>   force a region (must be allowed and offer Flex Consumption)
 *          --rg <name>       resource group name (default rg-2sdif)
 *          --n <N> --warmup <W>   trials for the store and retrieval benchmarks (default 50 / 10)
 * Secrets never appear in the log: they go to Key Vault through temporary files and are redacted from command lines.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const cp = require("child_process");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const argv = process.argv.slice(2);
const CMD = argv[0];
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i > 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const LOG = opt("log");
const STATE_FILE = path.join(ROOT, "deployments", "azure.json");
const RESULTS = path.join(ROOT, "results");
const HH = path.join(ROOT, "node_modules", "hardhat", "internal", "cli", "cli.js");
const WIN = process.platform === "win32";
const REGION_PREFERENCE = ["uaenorth", "centralindia", "southindia", "westindia", "qatarcentral", "israelcentral", "italynorth", "swedencentral", "northeurope", "westeurope", "polandcentral", "germanywestcentral", "francecentral", "uksouth", "southeastasia", "eastasia", "eastus", "eastus2"];
const DEFAULT_SEPOLIA_RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const secrets = new Set();

// ------------------------------------------------------------------ logging
function redact(s) {
  let out = String(s);
  for (const x of secrets) if (x && x.length >= 8) out = out.split(x).join("***");
  return out;
}
function log(...parts) {
  const line = redact(parts.join(" "));
  console.log(line);
  if (LOG) fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${line}\n`);
}
function logRaw(chunk) {
  const s = redact(chunk.toString());
  process.stdout.write(s);
  if (LOG) fs.appendFileSync(LOG, s);
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ------------------------------------------------------------------ state
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function setEnvVar(name, value) {
  const file = path.join(ROOT, ".env");
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const re = new RegExp(`^${name}=.*$`, "m");
  text = re.test(text) ? text.replace(re, `${name}=${value}`) : `${text.replace(/\n?$/, "\n")}${name}=${value}\n`;
  fs.writeFileSync(file, text);
  process.env[name] = value;
}

// ------------------------------------------------------------------ az
function quote(a) {
  a = String(a);
  if (/^[A-Za-z0-9_\-.,:/\\=@+[\]]+$/.test(a)) return a;
  if (WIN) {
    if (/["%^&|<>!]/.test(a)) throw new Error(`argument not safe for cmd.exe: ${redact(a)}`);
    return `"${a}"`;
  }
  return `'${a.replace(/'/g, "'\\''")}'`;
}
function az(args, { json = true, allowFail = false, quiet = false } = {}) {
  const full = ["az", ...args, ...(json ? ["-o", "json"] : []), "--only-show-errors"];
  const line = full.map(quote).join(" ");
  if (!quiet) log(`$ ${line}`);
  const r = cp.spawnSync(line, { shell: true, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, cwd: ROOT });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = `az exited with ${r.status}: ${redact((r.stderr || "").trim()).slice(0, 3000)}`;
    if (allowFail) { if (!quiet) log(`  (ignored) ${msg}`); return null; }
    throw new Error(msg);
  }
  const out = (r.stdout || "").trim();
  if (!json) return out;
  return out ? JSON.parse(out) : null;
}
function tmpFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "2sdif-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, content, { mode: 0o600 });
  return { file: f, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ------------------------------------------------------------------ processes
function spawnNode(args, { env = {}, logFile, name } = {}) {
  const child = cp.spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
  const sink = logFile ? fs.createWriteStream(logFile, { flags: "a" }) : null;
  const forward = (d) => (sink ? sink.write(d) : logRaw(d));
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);
  child.on("exit", (code) => { if (sink) sink.end(); if (code && name) log(`[${name}] exited with ${code}`); });
  return child;
}
function runNode(args, { env = {}, name = "task" } = {}) {
  log(`> node ${args.map((a) => path.relative(ROOT, a) || a).join(" ")}`);
  return new Promise((ok, fail) => {
    const child = spawnNode(args, { env });
    child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`${name} failed with exit code ${code}`))));
  });
}
async function waitFor(fn, { timeoutMs = 120000, everyMs = 1000, what = "condition" } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}
async function rpcUp(url) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  return r.ok;
}

// ------------------------------------------------------------------ helpers
function witnessAddress() {
  const { ethers } = require("ethers");
  if (!process.env.WITNESS_PRIVATE_KEY) throw new Error("WITNESS_PRIVATE_KEY missing: run `npm run keys` first");
  return new ethers.Wallet(process.env.WITNESS_PRIVATE_KEY).address;
}
function devicesFile() {
  return JSON.parse(fs.readFileSync(process.env.DEVICES_FILE || path.join(ROOT, "devices.json"), "utf8")).devices;
}
function witnessUrl(st) {
  if (!st.hostname) throw new Error("no deployment recorded; run `deploy` first");
  return /^https?:\/\//.test(st.hostname) ? `${st.hostname}/api` : `https://${st.hostname}/api`; // full URL form: local tests
}
async function health(st) {
  const r = await fetch(`${witnessUrl(st)}/health`);
  if (!r.ok) throw new Error(`health ${r.status}`);
  return r.json();
}
function copyResults() {
  const dst = opt("copy-to");
  if (!dst || !fs.existsSync(RESULTS)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(RESULTS)) {
    const src = path.join(RESULTS, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dst, f));
  }
  log(`[results] copied results/ to ${dst}`);
}

// ------------------------------------------------------------------ preflight
function preflight() {
  const acct = az(["account", "show"]);
  log(`[preflight] subscription "${acct.name}" (${acct.id}), state ${acct.state}`);
  // allowed regions: Azure for Students assigns an "Allowed resource deployment regions" policy
  let assignments = az(["policy", "assignment", "list", "--disable-scope-strict-match"], { allowFail: true });
  if (!assignments) assignments = az(["policy", "assignment", "list"], { allowFail: true }) || [];
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, "");
  let allowed = null;
  for (const a of assignments) {
    for (const [k, v] of Object.entries(a.parameters || {})) {
      if (/location/i.test(k) && Array.isArray(v && v.value)) {
        const vals = v.value.map(norm);
        allowed = allowed ? allowed.filter((x) => vals.includes(x)) : vals;
        log(`[preflight] policy "${a.displayName || a.name}" allows: ${vals.join(", ")}`);
      }
    }
  }
  const flex = (az(["functionapp", "list-flexconsumption-locations"]) || []).map((x) => norm(x.name));
  log(`[preflight] Flex Consumption regions: ${flex.length}`);
  const candidates = flex.filter((r) => !allowed || allowed.includes(r));
  if (!candidates.length) throw new Error("no region is both allowed by policy and offers Flex Consumption");
  const forced = opt("region") && norm(opt("region"));
  if (forced && !candidates.includes(forced)) throw new Error(`region ${forced} is not allowed or lacks Flex Consumption; candidates: ${candidates.join(", ")}`);
  const region = forced || REGION_PREFERENCE.find((r) => candidates.includes(r)) || candidates[0];
  log(`[preflight] candidates: ${candidates.join(", ")}`);
  log(`[preflight] selected region: ${region}`);
  for (const ns of ["Microsoft.Web", "Microsoft.Storage", "Microsoft.KeyVault", "Microsoft.Insights", "Microsoft.OperationalInsights"]) {
    const p = az(["provider", "show", "-n", ns], { allowFail: true, quiet: true });
    if (!p || p.registrationState !== "Registered") {
      log(`[preflight] registering resource provider ${ns}`);
      az(["provider", "register", "-n", ns, "--wait"], { json: false });
    }
  }
  const st = readState();
  writeState({ ...st, subscriptionId: acct.id, subscriptionName: acct.name, region, rg: opt("rg", st.rg || "rg-2sdif") });
  log("[preflight] ok");
}

// ------------------------------------------------------------------ deploy
function buildPackage() {
  const AdmZip = require("adm-zip");
  require("./prepare-azure");
  const base = path.join(ROOT, "witness", "azure");
  const zip = new AdmZip();
  for (const f of ["host.json", "package.json", "package-lock.json"]) zip.addLocalFile(path.join(base, f));
  zip.addLocalFolder(path.join(base, "src"), "src");
  const out = path.join(os.tmpdir(), `2sdif-witness-${Date.now()}.zip`);
  zip.writeZip(out);
  log(`[deploy] package ${out} (${(fs.statSync(out).size / 1024).toFixed(1)} KiB, built remotely)`);
  return out;
}
function setAppSettings(st, settings) {
  const t = tmpFile("settings.json", JSON.stringify(Object.entries(settings).map(([name, value]) => ({ name, value, slotSetting: false }))));
  try {
    az(["functionapp", "config", "appsettings", "set", "-g", st.rg, "-n", st.functionApp, "--settings", `@${t.file}`], { json: false });
  } finally { t.done(); }
}
async function waitHealthy(st, check, what, timeoutMs = 600000) {
  let restarted = false;
  const t0 = Date.now();
  return waitFor(async () => {
    try {
      const h = await health(st);
      if (check(h)) return h;
    } catch (e) {
      if (!restarted && Date.now() - t0 > 180000) {
        restarted = true;
        log("[deploy] witness still unhealthy after 3 min; restarting the function app");
        az(["functionapp", "restart", "-g", st.rg, "-n", st.functionApp], { json: false, allowFail: true });
      }
      throw e;
    }
    return null;
  }, { timeoutMs, everyMs: 5000, what });
}
async function deploy() {
  let st = readState();
  if (!st.region) { preflight(); st = readState(); }
  if (!fs.existsSync(path.join(ROOT, "devices.json"))) throw new Error("devices.json missing: run `npm run keys` first");
  secrets.add(process.env.WITNESS_PRIVATE_KEY);
  secrets.add(process.env.AUDITOR_KEY);
  const suffix = st.suffix || crypto.randomBytes(4).toString("hex").slice(0, 6);
  st = { ...st, suffix, storage: `st2sdif${suffix}`, keyVault: `kv-2sdif-${suffix}`, functionApp: `fn-2sdif-${suffix}` };
  writeState(st);
  const { rg, region } = st;

  az(["group", "create", "-n", rg, "-l", region, "--tags", "project=2sdif"]);
  az(["storage", "account", "create", "-n", st.storage, "-g", rg, "-l", region, "--sku", "Standard_LRS", "--kind", "StorageV2", "--min-tls-version", "TLS1_2", "--allow-blob-public-access", "false"]);
  const conn = az(["storage", "account", "show-connection-string", "-n", st.storage, "-g", rg], { quiet: false }).connectionString;
  secrets.add(conn);

  if (!az(["keyvault", "show", "-n", st.keyVault], { allowFail: true, quiet: true })) {
    az(["keyvault", "create", "-n", st.keyVault, "-g", rg, "-l", region, "--enable-rbac-authorization", "false"]);
  }
  const deviceKeys = Object.fromEntries(devicesFile().map((d) => [d.did, d.key]));
  for (const d of devicesFile()) secrets.add(d.key);
  for (const [name, value] of [["witness-key", process.env.WITNESS_PRIVATE_KEY], ["device-keys", JSON.stringify(deviceKeys)], ["table-conn", conn]]) {
    const t = tmpFile(name, value);
    try {
      az(["keyvault", "secret", "set", "--vault-name", st.keyVault, "-n", name, "--file", t.file, "--encoding", "utf-8"], { json: false, quiet: false });
    } finally { t.done(); }
    log(`[deploy] stored secret ${name} in Key Vault`);
  }

  if (!az(["functionapp", "show", "-g", rg, "-n", st.functionApp], { allowFail: true, quiet: true })) {
    const created = az(["functionapp", "create", "-g", rg, "-n", st.functionApp, "-s", st.storage, "--flexconsumption-location", region, "--runtime", "node", "--runtime-version", "22"], { allowFail: true });
    if (!created) {
      log("[deploy] Node.js 22 not accepted; retrying with Node.js 20");
      az(["functionapp", "create", "-g", rg, "-n", st.functionApp, "-s", st.storage, "--flexconsumption-location", region, "--runtime", "node", "--runtime-version", "20"]);
    }
  }
  const ident = az(["functionapp", "identity", "assign", "-g", rg, "-n", st.functionApp]);
  az(["keyvault", "set-policy", "-n", st.keyVault, "--object-id", ident.principalId, "--secret-permissions", "get", "list"]);
  const ref = (n) => `@Microsoft.KeyVault(SecretUri=https://${st.keyVault}.vault.azure.net/secrets/${n}/)`;
  setAppSettings(st, {
    WITNESS_PRIVATE_KEY: ref("witness-key"),
    DEVICE_KEYS: ref("device-keys"),
    WITNESS_TABLE_CONNECTION: ref("table-conn"),
    CHAIN_ID: "0",
    CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000",
  });

  const zip = buildPackage();
  try {
    az(["functionapp", "deployment", "source", "config-zip", "-g", rg, "-n", st.functionApp, "--src", zip, "--build-remote", "true"], { json: false });
  } finally { fs.rmSync(zip, { force: true }); }

  const app = az(["functionapp", "show", "-g", rg, "-n", st.functionApp]);
  st.hostname = app.defaultHostName || (app.properties && app.properties.defaultHostName);
  st.runtime = "node";
  st.deployedAt = new Date().toISOString();
  writeState(st);
  az(["functionapp", "keys", "set", "-g", rg, "-n", st.functionApp, "--key-type", "functionKeys", "--key-name", "auditor", "--key-value", process.env.AUDITOR_KEY]);

  const expected = witnessAddress();
  const h = await waitHealthy(st, (x) => x.ok && x.witness === expected, "the witness health endpoint");
  setEnvVar("WITNESS_URL", witnessUrl(st));
  log(`[deploy] witness ${h.witness} is live at ${witnessUrl(st)} (region ${region})`);
}

async function bindWitness(st, chainId, contract) {
  log(`[bind] binding the witness to chain ${chainId}, contract ${contract}`);
  setAppSettings(st, { CHAIN_ID: String(chainId), CONTRACT_ADDRESS: contract });
  await waitHealthy(st, (h) => h.chainId === String(chainId) && String(h.contract).toLowerCase() === contract.toLowerCase(), "the witness to pick up the new binding");
  log("[bind] ok");
}

// ------------------------------------------------------------------ bench
async function measureRtt(url, n = 30, warm = 5) {
  const rows = [];
  for (let i = 0; i < n + warm; i++) {
    const t0 = performance.now();
    const r = await fetch(`${url}/health`);
    await r.json();
    const ms = performance.now() - t0;
    if (i >= warm) rows.push({ trial: i - warm + 1, rttMs: ms.toFixed(3), execMs: r.headers.get("x-exec-ms") || "" });
  }
  fs.writeFileSync(path.join(RESULTS, "rtt_azure.csv"), ["trial,rttMs,execMs", ...rows.map((r) => `${r.trial},${r.rttMs},${r.execMs}`)].join("\n") + "\n");
  log(`[bench] health round trip: median ${median(rows.map((r) => Number(r.rttMs))).toFixed(1)} ms over ${rows.length}`);
}
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function csvMedian(file, col) {
  const [head, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  const i = head.split(",").indexOf(col);
  return median(lines.map((l) => Number(l.split(",")[i])).filter(Number.isFinite));
}
function environmentInfo(st, extra = {}) {
  let hh = "";
  try { hh = require(path.join(ROOT, "node_modules", "hardhat", "package.json")).version; } catch {}
  const cpus = os.cpus();
  const info = {
    recordedAt: new Date().toISOString(),
    host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: cpus[0] && cpus[0].model, cores: cpus.length, memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(1) },
    node: process.version,
    hardhat: hh,
    azure: { region: st.region, functionApp: st.functionApp, plan: "Flex Consumption", hostname: st.hostname },
    ...extra,
  };
  fs.writeFileSync(path.join(RESULTS, "environment.json"), JSON.stringify(info, null, 2));
  return info;
}

async function bench() {
  const st = readState();
  const url = witnessUrl(st);
  secrets.add(process.env.AUDITOR_KEY);
  const N = opt("n", "50"), W = opt("warmup", "10");
  fs.mkdirSync(RESULTS, { recursive: true });
  const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  const children = [];
  try {
    for (const f of ["localhost.json"]) fs.rmSync(path.join(ROOT, "deployments", f), { force: true });
    fs.rmSync(path.join(ROOT, "data", "localhost"), { recursive: true, force: true });
    log("[bench] starting the local chain (Hardhat node)");
    children.push(spawnNode([HH, "node", "--hostname", "127.0.0.1", "--port", "8545"], { logFile: path.join(RESULTS, "hardhat_node.log"), name: "hardhat node" }));
    await waitFor(() => rpcUp("http://127.0.0.1:8545"), { timeoutMs: 120000, what: "the Hardhat node" });
    await runNode([HH, "run", "scripts/deploy.js", "--network", "localhost"], { name: "deploy" });
    const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "localhost.json"), "utf8"));
    await bindWitness(st, dep.chainId, dep.address);

    log("[bench] starting the gateway");
    children.push(spawnNode(["gateway/server.js"], { env, logFile: path.join(RESULTS, "gateway.log"), name: "gateway" }));
    await waitFor(async () => (await fetch("http://127.0.0.1:3001/auth/nonce?address=x")).status === 400, { what: "the gateway" });

    await measureRtt(url);
    await runNode(["device/simulator.js", "--n", N, "--warmup", W, "--out", path.join(RESULTS, "latency_azure.csv")], { env, name: "store benchmark" });
    log(`[bench] store: median e2e ${csvMedian(path.join(RESULTS, "latency_azure.csv"), "e2eMs").toFixed(1)} ms, deposit ${csvMedian(path.join(RESULTS, "latency_azure.csv"), "depositMs").toFixed(1)} ms, fetch ${csvMedian(path.join(RESULTS, "latency_azure.csv"), "fetchMs").toFixed(1)} ms, witness exec (deposit) ${csvMedian(path.join(RESULTS, "latency_azure.csv"), "depositExecMs").toFixed(1)} ms`);
    await runNode(["scripts/bench-retrieve.js", "--n", N, "--warmup", W, "--out", path.join(RESULTS, "retrieve_azure.csv")], { env, name: "retrieval benchmark" });
    log(`[bench] retrieval: median ${csvMedian(path.join(RESULTS, "retrieve_azure.csv"), "retrieveMs").toFixed(1)} ms`);
    await runNode([HH, "test", "test/e2e.attacks.test.js", "--network", "localhost"], { env: { ...env, ATTACK_WITNESS_URL: url }, name: "attack suite (deployed witness)" });
  } finally {
    for (const c of children) c.kill();
    await sleep(1500);
  }
  await runNode(["device/simulator.js", "--crypto", "1000", "--out", path.join(RESULTS, "device_cost.csv")], { name: "device cost" });
  if (!argv.includes("--skip-local")) {
    await runNode([HH, "test"], { env: { ATTACK_WITNESS_URL: "" }, name: "contract tests and in-process attack suite" });
    await runNode([HH, "run", "scripts/gas-report.js"], { name: "gas report" });
  }
  environmentInfo(st, { trials: Number(N), warmup: Number(W) });
  await runNode(["scripts/stats.js", "--latency", path.join(RESULTS, "latency_azure.csv"), "--retrieve", path.join(RESULTS, "retrieve_azure.csv"), "--gas", path.join(RESULTS, "gas_hardhat.csv"), "--device", path.join(RESULTS, "device_cost.csv"), "--attacks", path.join(RESULTS, "attacks_remote.csv"), "--rtt", path.join(RESULTS, "rtt_azure.csv"), "--warmup", W, "--out", path.join(RESULTS, "results_values_azure.tex")], { name: "statistics" });
  copyResults();
  log("[bench] done");
}

// ------------------------------------------------------------------ Sepolia
async function sepoliaWallet() {
  const { ethers } = require("ethers");
  if (!process.env.ADMIN_PRIVATE_KEY) {
    setEnvVar("ADMIN_PRIVATE_KEY", ethers.Wallet.createRandom().privateKey);
    log("[sepolia] created a new throwaway admin wallet in .env");
  }
  if (!process.env.SEPOLIA_RPC_URL) setEnvVar("SEPOLIA_RPC_URL", DEFAULT_SEPOLIA_RPC);
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const admin = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  const gw = new ethers.Wallet(process.env.GATEWAY_PRIVATE_KEY, provider);
  const [a, g] = await Promise.all([provider.getBalance(admin.address), provider.getBalance(gw.address)]);
  log(`[sepolia] admin wallet ${admin.address}: ${ethers.formatEther(a)} SepoliaETH (fund this address from a faucet; about 0.1 is plenty)`);
  log(`[sepolia] gateway wallet ${gw.address}: ${ethers.formatEther(g)} SepoliaETH (topped up from the admin wallet automatically)`);
  return { provider, admin, gw, a, g };
}
async function sepolia() {
  const { ethers } = require("ethers");
  const st = readState();
  const url = witnessUrl(st);
  fs.mkdirSync(RESULTS, { recursive: true });
  const { provider, admin, gw, a, g } = await sepoliaWallet();
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas || fee.gasPrice || ethers.parseUnits("20", "gwei");
  const trials = Number(opt("n", "20")) + Number(opt("warmup", "2"));
  // Gas per operation differs by fork (e.g. Glamsterdam's state-creation pricing), so budget generously;
  // the fee cap can also rise during the run, hence a fixed floor for the gateway.
  const deployCost = 15000000n * maxFee;                      // contract deployment, with margin
  const gatewayNeed = BigInt(trials + 3) * 500000n * maxFee;  // one commitProof per trial, with margin
  log(`[sepolia] fee cap ${ethers.formatUnits(maxFee, "gwei")} gwei; deployment needs ~${ethers.formatEther(deployCost)}, the gateway ~${ethers.formatEther(gatewayNeed)} SepoliaETH`);
  const floor = ethers.parseEther("0.01");
  const want = gatewayNeed > floor ? gatewayNeed : floor;
  const topUp = g < want ? want - g : 0n;
  if (a < deployCost + topUp + ethers.parseEther("0.002")) {
    throw new Error(`the admin wallet ${admin.address} holds ${ethers.formatEther(a)} SepoliaETH but needs about ${ethers.formatEther(deployCost + topUp + ethers.parseEther("0.002"))}; fund it from a faucet and run again`);
  }
  const head = await provider.getBlock("latest");
  let client = "";
  try { client = await provider.send("web3_clientVersion", []); } catch {}
  log(`[sepolia] chain head ${head.number} at ${new Date(head.timestamp * 1000).toISOString()}${client ? `, RPC client ${client}` : ""}`);
  await runNode([HH, "run", "scripts/deploy.js", "--network", "sepolia"], { name: "deploy (Sepolia)" });
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "sepolia.json"), "utf8"));
  if (topUp > 0n) {
    log(`[sepolia] funding the gateway wallet with ${ethers.formatEther(topUp)} SepoliaETH`);
    await (await admin.sendTransaction({ to: gw.address, value: topUp })).wait();
  }
  await bindWitness(st, dep.chainId, dep.address);
  const env = { NETWORK: "sepolia", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  const children = [];
  try {
    fs.rmSync(path.join(ROOT, "data", "sepolia"), { recursive: true, force: true });
    for (const f of ["latency_sepolia.csv", "latency_sepolia.failures.json"]) fs.rmSync(path.join(RESULTS, f), { force: true });
    children.push(spawnNode(["gateway/server.js"], { env, logFile: path.join(RESULTS, "gateway_sepolia.log"), name: "gateway" }));
    await waitFor(async () => (await fetch("http://127.0.0.1:3001/auth/nonce?address=x")).status === 400, { what: "the gateway" });
    await runNode(["device/simulator.js", "--n", opt("n", "20"), "--warmup", opt("warmup", "2"), "--jitter", "12000", "--retries", "2", "--out", path.join(RESULTS, "latency_sepolia.csv")], { env, name: "Sepolia store benchmark" });
  } finally {
    for (const c of children) c.kill();
    await sleep(1000);
  }
  const end = await provider.getBlock("latest");
  const info = { chainId: dep.chainId, deployedAt: dep.deployedAt, contract: dep.address, deployBlock: dep.block, deployGas: dep.deployGas, startHead: head.number, endHead: end.number, feeCapGwei: ethers.formatUnits(maxFee, "gwei"), rpc: new URL(process.env.SEPOLIA_RPC_URL).host, rpcClient: client, finishedAt: new Date().toISOString() };
  const ff = path.join(RESULTS, "latency_sepolia.failures.json");
  info.failedAttempts = fs.existsSync(ff) ? JSON.parse(fs.readFileSync(ff, "utf8")).length : 0;
  fs.writeFileSync(path.join(RESULTS, "sepolia_run.json"), JSON.stringify(info, null, 2));
  log(`[sepolia] median commit ${(csvMedian(path.join(RESULTS, "latency_sepolia.csv"), "commitMs") / 1000).toFixed(2)} s`);
  copyResults();
  log("[sepolia] done");
}

// ------------------------------------------------------------------ status / teardown
async function status() {
  const st = readState();
  log(JSON.stringify({ ...st }, null, 2));
  if (st.hostname) {
    try { log(`[status] health: ${JSON.stringify(await health(st))}`); } catch (e) { log(`[status] health check failed: ${e.message}`); }
  }
}
function teardown() {
  const st = readState();
  if (!st.rg) { log("[teardown] nothing recorded"); return; }
  const exists = az(["group", "exists", "-n", st.rg], { json: false });
  if (exists === "true") az(["group", "delete", "-n", st.rg, "--yes"], { json: false });
  if (st.keyVault) az(["keyvault", "purge", "-n", st.keyVault], { json: false, allowFail: true });
  writeState({ subscriptionId: st.subscriptionId, subscriptionName: st.subscriptionName, region: st.region, rg: st.rg, removedAt: new Date().toISOString() });
  log(`[teardown] resource group ${st.rg} deleted`);
}

// ------------------------------------------------------------------ main
async function main() {
  if (LOG) fs.mkdirSync(path.dirname(path.resolve(LOG)), { recursive: true });
  log(`=== 2SDIF azure ${CMD} (${new Date().toISOString()}) ===`);
  const steps = { preflight, deploy, bench, sepolia, "sepolia-wallet": sepoliaWallet, status, teardown };
  if (!steps[CMD]) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 24).join("\n"));
    process.exit(CMD ? 1 : 0);
  }
  if (CMD !== "sepolia-wallet" && CMD !== "status") {
    const v = cp.spawnSync("az version -o json", { shell: true, encoding: "utf8" });
    if (v.status !== 0) throw new Error("Azure CLI not found: install it and run `az login` first");
  }
  await steps[CMD]();
}

main().catch((e) => {
  log(`ERROR: ${e.message}`);
  copyResults();
  process.exit(1);
});
