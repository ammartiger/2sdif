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
 *   node scripts/azure.js revision         all revision experiments (see the "revision experiments" section);
 *                                          --only core,retrieve,attacks,keepalive,plain,load,audit,local,idle,
 *                                                 restarts,kvsign,sepolia,metrics,gas
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
function deployPackage(st) {
  const zip = buildPackage();
  try {
    az(["functionapp", "deployment", "source", "config-zip", "-g", st.rg, "-n", st.functionApp, "--src", zip, "--build-remote", "true"], { json: false });
  } finally { fs.rmSync(zip, { force: true }); }
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
  az(["keyvault", "set-policy", "-n", st.keyVault, "--object-id", ident.principalId, "--secret-permissions", "get", "list", "--key-permissions", "get", "sign"]);
  const ref = (n) => `@Microsoft.KeyVault(SecretUri=https://${st.keyVault}.vault.azure.net/secrets/${n}/)`;
  setAppSettings(st, {
    WITNESS_PRIVATE_KEY: ref("witness-key"),
    DEVICE_KEYS: ref("device-keys"),
    WITNESS_TABLE_CONNECTION: ref("table-conn"),
    CHAIN_ID: "0",
    CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000000",
  });

  deployPackage(st);

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
  writeState({ ...readState(), bound: { chainId: String(chainId), contract, at: new Date().toISOString() } });
  log("[bind] ok");
}

// ------------------------------------------------------------------ bench
async function measureRtt(url, n = 30, warm = 5) {
  const rows = [];
  for (let i = 0; i < n + warm; i++) {
    const wall0 = Date.now();
    const t0 = performance.now();
    const r = await fetch(`${url}/health`);
    await r.json();
    const ms = performance.now() - t0;
    // clock offset estimate from the HTTP Date header (1 s resolution: +/- 0.5 s)
    const d = Date.parse(r.headers.get("date") || "");
    const offsetMs = Number.isFinite(d) ? (d + 500 - (wall0 + ms / 2)).toFixed(0) : "";
    if (i >= warm) rows.push({ trial: i - warm + 1, rttMs: ms.toFixed(3), execMs: r.headers.get("x-exec-ms") || "", offsetMs });
  }
  fs.writeFileSync(path.join(RESULTS, "rtt_azure.csv"), ["trial,rttMs,execMs,offsetMs", ...rows.map((r) => `${r.trial},${r.rttMs},${r.execMs},${r.offsetMs}`)].join("\n") + "\n");
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
async function sepolia({ n = opt("n", "20"), warmup = opt("warmup", "2") } = {}) {
  const { ethers } = require("ethers");
  const st = readState();
  const url = witnessUrl(st);
  fs.mkdirSync(RESULTS, { recursive: true });
  const { provider, admin, gw, a, g } = await sepoliaWallet();
  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas || fee.gasPrice || ethers.parseUnits("20", "gwei");
  const trials = Number(n) + Number(warmup);
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
    await runNode(["device/simulator.js", "--n", String(n), "--warmup", String(warmup), "--jitter", "12000", "--retries", "2", "--out", path.join(RESULTS, "latency_sepolia.csv")], { env, name: "Sepolia store benchmark" });
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
  try {
    await runNode(["scripts/sepolia-blocks.js"], { name: "Sepolia block analysis" });
  } catch (e) { log(`[sepolia] block analysis failed: ${e.message}`); }
  copyResults();
  log("[sepolia] done");
}

// ------------------------------------------------------------------ revision experiments
// One command runs every experiment of the revised evaluation, in an order that leaves the witness
// idle while the local-only experiments run (so idle cold starts can be measured without extra waiting):
//   core      RTT probe, store path (N trials), retrieval, attack suite against the deployed witness
//   keepalive keep-alive on/off x back-to-back / 10 s idle gap (connection reuse ablation)
//   plain     the device's deposit over plain HTTP vs HTTPS, without connection reuse (TLS cost on channel 2)
//   load      witness bursts and fixed-rate load; end-to-end store path with 1..100 concurrent devices
//   audit     periodic auditor on a 12 s slot chain against a faulty gateway (withhold / delay / suppress)
//   local     (witness idle) contract tests and in-process attack suite, gas (Osaka), device cost, baselines B0-B2
//   idle      cold start after the idle period; a second idle period overlaps the Sepolia gas report
//   restarts  cold start after app restarts
//   kvsign    attestations signed by a non-exportable P-256K key in Key Vault (latency cost of an HSM-style key)
//   sepolia   Sepolia store path (100 trials) and block/slot analysis
//   metrics   Azure Monitor billing meters for the function app over the run, and the app's scale settings
// Each step is independent: a failed step is logged in results/revision_status.json and the run continues.
const live = new Set();
function track(c) {
  live.add(c);
  c.on("exit", () => live.delete(c));
  return c;
}
async function stopChild(c) {
  if (!c || c.exitCode !== null) return;
  await new Promise((ok) => { c.once("exit", ok); c.kill(); setTimeout(ok, 5000); });
}
process.on("exit", () => { for (const c of live) { try { c.kill(); } catch {} } });

function revStatus(step, ok, detail = "", ms = 0) {
  const f = path.join(RESULTS, "revision_status.json");
  let s = {};
  try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s[step] = { ok, detail, minutes: +(ms / 60000).toFixed(1), at: new Date().toISOString() };
  fs.writeFileSync(f, JSON.stringify(s, null, 2));
}

const rev = { chain: null, slot: null, local: null };
async function startChain(port, env, logName) {
  const url = `http://127.0.0.1:${port}`;
  if (await rpcUp(url).catch(() => false)) {
    log(`[rev] a chain is already running on port ${port}; using it`);
    return null;
  }
  const c = track(spawnNode([HH, "node", "--hostname", "127.0.0.1", "--port", String(port)], { env, logFile: path.join(RESULTS, logName), name: `hardhat node :${port}` }));
  await waitFor(() => rpcUp(url), { timeoutMs: 120000, what: `the Hardhat node on port ${port}` });
  return c;
}
async function ensureLocal(st, { bind = true } = {}) {
  if (!rev.chain && !(await rpcUp("http://127.0.0.1:8545").catch(() => false))) {
    log("[rev] starting the local chain (Hardhat node, automine)");
    rev.chain = await startChain(8545, {}, "hardhat_node.log");
  }
  if (!rev.local) {
    await runNode([HH, "run", "scripts/deploy.js", "--network", "localhost"], { name: "deploy (localhost)" });
    rev.local = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "localhost.json"), "utf8"));
    fs.rmSync(path.join(ROOT, "data", "localhost"), { recursive: true, force: true });
  }
  const b = readState().bound || {};
  if (bind && (b.chainId !== String(rev.local.chainId) || String(b.contract).toLowerCase() !== rev.local.address.toLowerCase())) {
    await bindWitness(readState(), rev.local.chainId, rev.local.address);
  }
  return rev.local;
}
async function startGateway(env, port = 3001, logName = "gateway.log") {
  const c = track(spawnNode(["gateway/server.js"], { env: { ...env, GATEWAY_PORT: String(port) }, logFile: path.join(RESULTS, logName), name: `gateway :${port}` }));
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/auth/nonce?address=x`)).status === 400, { what: `the gateway on port ${port}` });
  return c;
}
function csvSummary(file, cols) {
  return cols.map((c) => `${c} ${csvMedian(file, c).toFixed(1)}`).join(", ");
}

async function revCore(st, url) {
  const N = opt("n", "100"), W = opt("warmup", "10");
  await ensureLocal(st);
  const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  await measureRtt(url);
  const gw = await startGateway(env);
  try {
    const f = path.join(RESULTS, "latency_azure.csv");
    await runNode(["device/simulator.js", "--n", N, "--warmup", W, "--out", f], { env, name: "store benchmark" });
    log(`[rev] store medians (ms): ${csvSummary(f, ["e2eMs", "depositMs", "fetchMs", "commitMs", "depositExecMs"])}`);
  } finally { await stopChild(gw); }
}

async function revRetrieve(st, url) {
  await ensureLocal(st);
  const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  const gw = await startGateway(env);
  try {
    await runNode(["scripts/bench-retrieve.js", "--n", "50", "--warmup", "10", "--out", path.join(RESULTS, "retrieve_azure.csv")], { env, name: "retrieval benchmark" });
    log(`[rev] retrieval median ${csvMedian(path.join(RESULTS, "retrieve_azure.csv"), "retrieveMs").toFixed(1)} ms`);
  } finally { await stopChild(gw); }
}

async function revAttacks(st, url) {
  await ensureLocal(st);
  const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  await runNode([HH, "test", "test/e2e.attacks.test.js", "--network", "localhost"], { env: { ...env, ATTACK_WITNESS_URL: url }, name: "attack suite (deployed witness)" });
}

async function revKeepAlive(st, url) {
  await ensureLocal(st);
  const N = opt("ka-n", "30");
  for (const ka of ["60000", "0"]) {
    const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001", KEEPALIVE_MS: ka };
    const gw = await startGateway(env);
    try {
      for (const gap of ["0", "10000"]) {
        const f = path.join(RESULTS, `ka_${ka === "0" ? "off" : "on"}_gap${Number(gap) / 1000}.csv`);
        await runNode(["device/simulator.js", "--n", N, "--warmup", "3", "--gap", gap, "--out", f], { env, name: `keep-alive ${ka} gap ${gap}` });
        log(`[rev] keep-alive ${ka === "0" ? "off" : "on"}, gap ${gap} ms: ${csvSummary(f, ["depositMs", "fetchMs", "e2eMs"])}`);
      }
    } finally { await stopChild(gw); }
  }
}

async function revLoad(st, url) {
  await ensureLocal(st);
  const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
  await runNode(["scripts/bench-load.js", "witness", "--levels", opt("levels", "1,10,50,100,200"), "--rounds", "3"], { env, name: "witness bursts" });
  await runNode(["scripts/bench-load.js", "rate", "--rates", opt("rates", "5,20,50,100"), "--duration", "20"], { env, name: "witness fixed-rate load" });
  const gw = await startGateway(env);
  try {
    await runNode(["scripts/bench-load.js", "e2e", "--devices", opt("devices", "1,10,50,100"), "--per-device", "10"], { env, name: "end-to-end load" });
  } finally { await stopChild(gw); }
}

async function revPlain(st, url) {
  // The deposit authenticates itself (HMAC tag) and the attestation is a signature, so channel 2 does not
  // need TLS for integrity; digests carry no plaintext (128-bit nonce). This step sends the device's deposits
  // over plain HTTP, without connection reuse, to measure what TLS setup costs a device that wakes per reading.
  await ensureLocal(st);
  const app = az(["functionapp", "show", "-g", st.rg, "-n", st.functionApp]);
  const httpsOnly = !!(app.httpsOnly ?? (app.properties && app.properties.httpsOnly));
  const setHttpsOnly = (v) => az(["resource", "update", "--ids", app.id, "--set", `properties.httpsOnly=${v}`], { allowFail: true });
  if (httpsOnly) { log("[rev] plain: allowing HTTP on the test app for this step"); setHttpsOnly(false); }
  const plainUrl = url.replace(/^https:/, "http:");
  try {
    await waitFor(async () => (await fetch(`${plainUrl}/health`, { redirect: "manual" })).status === 200, { timeoutMs: 300000, everyMs: 10000, what: "the witness to answer over plain HTTP" });
    const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001", KEEPALIVE_MS: "0" };
    const gw = await startGateway(env);
    try {
      for (const [name, wurl] of [["https", url], ["http", plainUrl]]) {
        const f = path.join(RESULTS, `channel2_${name}.csv`);
        // the gateway always fetches attestations over HTTPS; only the device's deposit changes
        await runNode(["device/simulator.js", "--n", opt("ka-n", "30"), "--warmup", "3", "--out", f], { env: { ...env, WITNESS_URL: wurl }, name: `deposit over ${name}` });
        log(`[rev] deposit over ${name} (no connection reuse): ${csvSummary(f, ["depositMs", "depositExecMs", "e2eMs"])}`);
      }
    } finally { await stopChild(gw); }
  } finally {
    if (httpsOnly) { setHttpsOnly(true); log("[rev] plain: HTTPS-only restored"); }
  }
}

async function revKvSign(st, url) {
  // Attestations signed by a non-exportable secp256k1 key in Key Vault instead of a key held in memory.
  const { ethers } = require("ethers");
  const name = "witness-signing";
  let key = az(["keyvault", "key", "show", "--vault-name", st.keyVault, "-n", name], { allowFail: true, quiet: true });
  if (!key) key = az(["keyvault", "key", "create", "--vault-name", st.keyVault, "-n", name, "--kty", "EC", "--curve", "P-256K", "--ops", "sign", "verify"]);
  const b = (v) => Buffer.from(String(v).replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const address = ethers.computeAddress("0x04" + b(key.key.x).toString("hex") + b(key.key.y).toString("hex"));
  log(`[rev] kvsign: Key Vault key ${key.key.kid} -> witness address ${address}`);
  const ident = az(["functionapp", "identity", "show", "-g", st.rg, "-n", st.functionApp]);
  az(["keyvault", "set-policy", "-n", st.keyVault, "--object-id", ident.principalId, "--secret-permissions", "get", "list", "--key-permissions", "get", "sign"]);
  deployPackage(st); // a package that includes the Key Vault client libraries
  setAppSettings(st, { WITNESS_KEY_ID: key.key.kid });
  try {
    await waitHealthy(st, (h) => h.signer === "keyvault" && h.witness === address, "the witness to sign with the Key Vault key");
    rev.local = null; // a contract that registers the Key Vault address as its witness
    await runNode([HH, "run", "scripts/deploy.js", "--network", "localhost"], { env: { WITNESS_ADDRESS: address }, name: "deploy (Key Vault witness)" });
    const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "localhost.json"), "utf8"));
    await bindWitness(readState(), dep.chainId, dep.address);
    fs.rmSync(path.join(ROOT, "data", "localhost"), { recursive: true, force: true });
    const env = { NETWORK: "localhost", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3001" };
    const gw = await startGateway(env);
    try {
      const f = path.join(RESULTS, "latency_kvsign.csv");
      await runNode(["device/simulator.js", "--n", opt("kv-n", "50"), "--warmup", "10", "--out", f], { env, name: "store benchmark (Key Vault signing)" });
      log(`[rev] Key Vault signing medians (ms): ${csvSummary(f, ["depositMs", "depositExecMs", "e2eMs"])}`);
    } finally { await stopChild(gw); }
  } finally {
    az(["functionapp", "config", "appsettings", "delete", "-g", st.rg, "-n", st.functionApp, "--setting-names", "WITNESS_KEY_ID"], { json: false, allowFail: true });
    rev.local = null;
    await waitHealthy(readState(), (h) => h.signer !== "keyvault", "the witness to return to its in-memory key").catch((e) => log(`[rev] kvsign: ${e.message}`));
  }
}

async function revAudit(st, url) {
  const delta = "30", skew = "5", period = "10";
  rev.slot = await startChain(8546, { HARDHAT_BLOCK_INTERVAL_MS: "12000", HARDHAT_CHAIN_ID: "31338" }, "hardhat_slot12.log");
  try {
    await runNode([HH, "run", "scripts/deploy.js", "--network", "slot12"], { name: "deploy (12 s slot chain)" });
    const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "slot12.json"), "utf8"));
    await bindWitness(st, dep.chainId, dep.address);
    fs.rmSync(path.join(ROOT, "data", "slot12"), { recursive: true, force: true });
    for (const f of ["audit_watch.csv", "audit_truth.csv", "audit_truth.receipts.json", "audit_summary.json"]) fs.rmSync(path.join(RESULTS, f), { force: true });
    const env = { NETWORK: "slot12", WITNESS_URL: url, GATEWAY_URL: "http://127.0.0.1:3003" };
    const gw = await startGateway({ ...env, FAULT_WITHHOLD_EVERY: "6", FAULT_DELAY_EVERY: "7", FAULT_DELAY_MS: "45000" }, 3003, "gateway_faulty.log");
    const since = String(Math.floor(Date.now() / 1000) - 5);
    const auditor = track(spawnNode(["auditor/audit.js", "--watch", "--period", period, "--delta", delta, "--skew", skew, "--since", since, "--duration", "3600", "--out", path.join(RESULTS, "audit_watch.csv")], { env, logFile: path.join(RESULTS, "auditor.log"), name: "auditor" }));
    try {
      await runNode(["device/simulator.js", "--fault-run", "--n", opt("audit-n", "40"), "--gap", "3000", "--suppress-every", "15", "--out", path.join(RESULTS, "audit_truth.csv")], { env, name: "omission experiment" });
      log("[rev] waiting 110 s for the last delayed commitments and audit passes");
      await sleep(110000);
    } finally {
      await stopChild(auditor);
      await stopChild(gw);
    }
    await runNode(["scripts/analyze-audit.js", "--network", "slot12", "--delta", delta, "--skew", skew, "--period", period], { name: "audit analysis" });
  } finally {
    await stopChild(rev.slot);
    rev.slot = null;
  }
}

async function revLocal() {
  // no witness traffic in this step: the deployed witness stays idle
  await runNode([HH, "test"], { env: { ATTACK_WITNESS_URL: "" }, name: "contract tests and in-process attack suite" });
  await runNode([HH, "run", "scripts/gas-report.js"], { name: "gas report (Osaka)" });
  await runNode(["device/simulator.js", "--crypto", "1000", "--warmup", "100", "--out", path.join(RESULTS, "device_cost.csv")], { name: "device cost" });
  await ensureLocal(readState(), { bind: false });
  await runNode([HH, "run", "scripts/deploy-baselines.js", "--network", "localhost"], { name: "deploy baselines" });
  const env = { NETWORK: "localhost", BASELINE_URL: "http://127.0.0.1:3002" };
  const bg = track(spawnNode(["gateway/baselines.js"], { env, logFile: path.join(RESULTS, "gateway_baselines.log"), name: "baseline gateway" }));
  try {
    await waitFor(async () => (await fetch("http://127.0.0.1:3002/health")).ok, { what: "the baseline gateway" });
    for (const m of ["B0", "B1", "B2"]) {
      const f = path.join(RESULTS, `latency_${m}.csv`);
      await runNode(["device/simulator.js", "--baseline", m, "--n", opt("n", "100"), "--warmup", "10", "--out", f], { env, name: `baseline ${m}` });
      log(`[rev] ${m} medians (ms): ${csvSummary(f, ["e2eMs", "signMs", "verifyMs", "commitMs"])}`);
    }
  } finally { await stopChild(bg); }
}

async function coldProbe(label, idleSec = "") {
  const b = readState().bound;
  if (!b) throw new Error("the witness is not bound to a deployment");
  await runNode(["scripts/bench-cold.js", "--label", label, "--chain-id", b.chainId, "--contract", b.contract, "--idle-sec", String(idleSec)], { env: { WITNESS_URL: witnessUrl(readState()) }, name: `cold-start probe ${label}` });
}
async function idlePeriod(label, minutes, during) {
  const t0 = Date.now();
  log(`[rev] ${label}: witness idle for ${minutes} min`);
  if (during) {
    try { await during(); } catch (e) { log(`[rev] ${label}: work during the idle period failed: ${e.message}`); revStatus(`${label}-work`, false, e.message); }
  }
  const left = minutes * 60000 - (Date.now() - t0);
  if (left > 0) {
    log(`[rev] ${label}: waiting another ${(left / 60000).toFixed(1)} min`);
    await sleep(left);
  }
  await coldProbe(label, Math.round((Date.now() - t0) / 1000));
}

async function revRestarts(st) {
  for (let i = 1; i <= Number(opt("restarts", "5")); i++) {
    az(["functionapp", "restart", "-g", st.rg, "-n", st.functionApp], { json: false });
    log("[rev] restarted the function app; waiting 60 s before the probe");
    await sleep(60000);
    await coldProbe(`restart-${i}`);
  }
}

function revMetrics(st, start) {
  const app = az(["functionapp", "show", "-g", st.rg, "-n", st.functionApp]);
  const conf = (app.properties && app.properties.functionAppConfig) || app.functionAppConfig || {};
  const end = new Date();
  const defs = az(["monitor", "metrics", "list-definitions", "--resource", app.id], { allowFail: true, quiet: true }) || [];
  const names = defs.map((d) => (d.name && (d.name.value || d.name)) || "").filter(Boolean);
  const wanted = ["OnDemandFunctionExecutionCount", "OnDemandFunctionExecutionUnits", "AlwaysReadyFunctionExecutionCount", "AlwaysReadyFunctionExecutionUnits", "AlwaysReadyUnits", "FunctionExecutionCount", "FunctionExecutionUnits", "Requests", "Http5xx", "Http4xx"].filter((m) => names.includes(m));
  const metrics = wanted.length
    ? az(["monitor", "metrics", "list", "--resource", app.id, "--metrics", ...wanted, "--start-time", start.toISOString(), "--end-time", end.toISOString(), "--interval", "PT1H", "--aggregation", "Total"], { allowFail: true })
    : null;
  fs.writeFileSync(path.join(RESULTS, "azure_metrics.json"), JSON.stringify({ start, end, scaleAndConcurrency: conf.scaleAndConcurrency || null, runtime: conf.runtime || null, availableMetrics: names, metrics }, null, 2));
  log(`[rev] Azure metrics: ${wanted.length ? wanted.join(", ") : "none of the billing meters are exposed"}; scale settings ${JSON.stringify(conf.scaleAndConcurrency || {})}`);
}

async function revGas() {
  // gas only (no witness needed): Osaka on the in-process chain, Glamsterdam on Sepolia if a wallet is set
  await runNode([HH, "run", "scripts/gas-report.js"], { name: "gas report (Osaka)" });
  if (process.env.ADMIN_PRIVATE_KEY && process.env.SEPOLIA_RPC_URL) {
    await runNode([HH, "run", "scripts/gas-report.js", "--network", "sepolia"], { env: { COMMITS: "5" }, name: "gas report (Sepolia)" });
  }
}

async function revision() {
  let st = readState();
  const only = opt("only") ? opt("only").split(",") : null;
  const witnessFree = only && only.every((x) => ["gas"].includes(x));
  let healthy = false;
  if (st.hostname) { try { healthy = !!(await health(st)).ok; } catch {} }
  if (!healthy && !witnessFree) {
    log("[rev] no live witness recorded: deploying it first");
    await deploy();
    st = readState();
  }
  const url = witnessFree ? null : witnessUrl(st);
  secrets.add(process.env.AUDITOR_KEY);
  // a full run starts from an empty results/ so that no file from an earlier run can be mistaken for a new one
  if (!only && fs.existsSync(RESULTS) && fs.readdirSync(RESULTS).length) {
    const prev = path.join(ROOT, `results_prev_${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.renameSync(RESULTS, prev);
    log(`[rev] moved the previous results/ to ${path.basename(prev)}`);
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  const want = (s) => !only || only.includes(s);
  const start = new Date();
  const step = async (name, fn) => {
    if (!want(name)) return;
    const t0 = Date.now();
    log(`[rev] ===== ${name} =====`);
    try {
      await fn();
      revStatus(name, true, "", Date.now() - t0);
      log(`[rev] ${name} done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    } catch (e) {
      revStatus(name, false, e.message, Date.now() - t0);
      log(`[rev] ${name} FAILED: ${e.message} (continuing)`);
    }
    copyResults();
  };
  const idleMin = Number(opt("idle-min", "20"));
  try {
    await step("core", () => revCore(st, url));
    await step("retrieve", () => revRetrieve(st, url));
    await step("attacks", () => revAttacks(st, url));
    await step("keepalive", () => revKeepAlive(st, url));
    await step("plain", () => revPlain(st, url));
    await step("load", () => revLoad(st, url));
    await step("audit", () => revAudit(st, url));
    if (want("idle")) {
      await step("idle", async () => {
        await idlePeriod("idle-1", idleMin, want("local") ? async () => { const t = Date.now(); await revLocal(); revStatus("local", true, "", Date.now() - t); } : null);
        await idlePeriod("idle-2", idleMin, want("sepolia") && process.env.ADMIN_PRIVATE_KEY && process.env.SEPOLIA_RPC_URL
          ? () => runNode([HH, "run", "scripts/gas-report.js", "--network", "sepolia"], { env: { COMMITS: "5" }, name: "gas report (Sepolia)" })
          : null);
      });
    } else {
      await step("local", revLocal);
    }
    await step("restarts", () => revRestarts(st));
    await step("kvsign", () => revKvSign(readState(), url));
    await step("sepolia", () => sepolia({ n: opt("sepolia-n", "100"), warmup: "2" }));
    if (only && only.includes("gas")) await step("gas", revGas);
  } finally {
    for (const c of [...live]) await stopChild(c);
    rev.chain = null;
  }
  if (!witnessFree) await step("metrics", async () => revMetrics(readState(), start));
  let nDevices = 0;
  try { nDevices = devicesFile().length; } catch {}
  if (!witnessFree) environmentInfo(readState(), { revision: true, trials: Number(opt("n", "100")), warmup: Number(opt("warmup", "10")), idleMinutes: idleMin, devices: nDevices });
  copyResults();
  log("[rev] all steps finished; see results/revision_status.json for the outcome of each step");
}

// ------------------------------------------------------------------ status / teardown
async function status() {
  const st = readState();
  log(JSON.stringify({ ...st }, null, 2));
  if (st.hostname) {
    try { log(`[status] health: ${JSON.stringify(await health(st))}`); } catch (e) { log(`[status] health check failed: ${e.message}`); }
  }
}
function listResources(label) {
  const res = az(["resource", "list"], { allowFail: true, quiet: true }) || [];
  log(`[teardown] ${label}: ${res.length} resource(s) in subscription`);
  for (const r of res) log(`[teardown]   ${r.resourceGroup} / ${r.type} / ${r.name} (${r.location})`);
  return res;
}
function teardown() {
  const st = readState();
  const acct = az(["account", "show"]);
  log(`[teardown] subscription "${acct.name}" (${acct.id})`);
  listResources("before");
  // 1) the project resource group: Function App, Flex plan, storage, Key Vault, Application Insights, alert rules
  const rg = st.rg || "rg-2sdif";
  if (az(["group", "exists", "-n", rg], { json: false }) === "true") {
    log(`[teardown] deleting resource group ${rg} (takes a few minutes)`);
    az(["group", "delete", "-n", rg, "--yes"], { json: false });
  } else {
    log(`[teardown] resource group ${rg} does not exist`);
  }
  // 2) Key Vault is soft-deleted by default: purge it so nothing lingers
  const deletedVaults = az(["keyvault", "list-deleted", "--resource-type", "vault"], { allowFail: true, quiet: true }) || [];
  for (const v of deletedVaults) {
    if (/^kv-2sdif-/i.test(v.name)) {
      log(`[teardown] purging soft-deleted Key Vault ${v.name}`);
      az(["keyvault", "purge", "-n", v.name], { json: false, allowFail: true });
    }
  }
  // 3) Application Insights created a default Log Analytics workspace in its own resource group
  const workspaces = az(["monitor", "log-analytics", "workspace", "list"], { allowFail: true, quiet: true }) || [];
  for (const w of workspaces) {
    if (/^DefaultWorkspace-/i.test(w.name) && /^DefaultResourceGroup-/i.test(w.resourceGroup)) {
      log(`[teardown] deleting default Log Analytics workspace ${w.name} in ${w.resourceGroup}`);
      az(["monitor", "log-analytics", "workspace", "delete", "-g", w.resourceGroup, "-n", w.name, "--force", "true", "--yes"], { json: false, allowFail: true });
      const left = az(["resource", "list", "-g", w.resourceGroup], { allowFail: true, quiet: true }) || [];
      if (!left.length) {
        log(`[teardown] deleting the now empty resource group ${w.resourceGroup}`);
        az(["group", "delete", "-n", w.resourceGroup, "--yes"], { json: false, allowFail: true });
      }
    }
  }
  const after = listResources("after");
  const groups = (az(["group", "list"], { allowFail: true, quiet: true }) || []).map((g) => g.name);
  log(`[teardown] resource groups left: ${groups.length ? groups.join(", ") : "none"}`);
  writeState({ subscriptionId: st.subscriptionId, subscriptionName: st.subscriptionName, region: st.region, rg, removedAt: new Date().toISOString() });
  log(after.length ? "[teardown] done; the resources listed above remain (not created by 2SDIF, or still deleting)" : "[teardown] done; no resources remain in the subscription");
}

// ------------------------------------------------------------------ main
async function main() {
  if (LOG) fs.mkdirSync(path.dirname(path.resolve(LOG)), { recursive: true });
  log(`=== 2SDIF azure ${CMD} (${new Date().toISOString()}) ===`);
  const steps = { preflight, deploy, bench, sepolia: () => sepolia(), "sepolia-wallet": sepoliaWallet, revision, status, teardown };
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
