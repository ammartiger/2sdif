# 2SDIF prototype (v2.1)

Serverless dual channel witness for accountable fog oracles, demonstrated on a smart healthcare scenario.
This version implements the design described in the Journal of Systems Architecture revision.

2SDIF is an accountable fog oracle. A device sends each record over two channels: the record itself goes through
the fog to the gateway, while an HMAC-authenticated digest of it goes directly to a serverless witness. The
witness signs an attestation of the digest it received, and the smart contract verifies that attestation before it
accepts the gateway's commitment, so a fog node that alters a record in transit is stopped on chain and one that
withholds a record is exposed by an audit of the witness log.

**Paper:** "2SDIF: A Serverless Dual Channel Oracle for Data in Transit Integrity in Blockchain Enabled Fog IoT
Systems" (under review, Journal of Systems Architecture). To cite this repository, see [CITATION.cff](CITATION.cff).

## Reproducing the paper

- **Submitted version:** the code and measurements behind the submitted manuscript are release
  [`v1.0.0-jsa`](https://github.com/ammartiger/2sdif/releases/tag/v1.0.0-jsa). The `main` branch has since moved
  on to v2.1 (the revision), so check out that tag to rerun the submitted version's code and tests.
- **Numbers:** [paper_results/README.md](paper_results/README.md) describes the raw per-trial measurements in
  `paper_results/` and gives the one `scripts/stats.js` command that regenerates every number in the submitted
  paper from them.
- **Tests:** `npm test` runs the contract tests, the Key Vault signer tests and the end-to-end attack suite T1–T9
  (37 passing tests on `main`; 22 at `v1.0.0-jsa`), with no cloud account.
- **Azure and Sepolia runs:** `scripts/azure.js` (wrapped by `run_azure.ps1` on Windows) deploys the witness to
  your own Azure subscription and reruns the experiments; see
  [Azure witness, experiments and Sepolia](#azure-witness-experiments-and-sepolia).

## Security note

This repository contains no keys. `npm run keys` generates them locally into `.env` and `devices.json`, which are
git-ignored; never commit either file. Use throwaway wallets on public testnets.

## Architecture

```
device ──(channel 2: did, seq, SHA-256 digest h, time t, deployment id dep, HMAC tag)──► witness (Azure Functions)
   │                                                                    signs  H("2SDIF-v2", chainId, contract, did, seq, h, tW)
   └──(channel 1: record)──► fog gateway ── signed receipt for (rid, h) back to the device
                                  └── commitProof(did, seq, h, tW, σW) ──► contract: rid = H(did, seq), ecrecover(σW) == witness
auditor: witness log  vs  ProofCommitted events  → OMITTED / LATE / MISMATCH / INVALID / GAP
```

Record identifiers are bound to the device: `rid = keccak256(abi.encode(did, seq))`, so no other device, gateway or
third party can occupy them. Attestations are bound to one chain and one contract, and the witness serves only
the deployment it is bound to. The gateway persists a record before it commits it, signs a receipt the device
keeps, and treats a commitment that someone else made first with the same attestation as success.

## Layout

| Path | What it is |
|---|---|
| `contracts/TwoSDIFRegistry.sol` | Witness-verified proofs (`commitProof`, and `commitBatch` with one Merkle root per batch), delayed witness rotation, registration, PHI and prescription records, contract-enforced ACLs |
| `shared/protocol.js` | Canonical JSON, SHA-256 digest, HMAC tag, attestation message (identical to the contract) |
| `witness/core.js` | Witness logic: verify HMAC, write once, sign attestation, serve log |
| `witness/azure/` | Azure Functions app (Flex Consumption) using Table Storage; secrets from Key Vault; optional signing with a non-exportable Key Vault key (`src/kvSigner.js`) |
| `witness/local-server.js` | Local emulator with the same routes, for dry runs |
| `gateway/` | Fog gateway (Express): early check, `commitProof`, record store, authenticated reads |
| `device/` | Sensor simulator (`device.js`) and benchmark CLI (`simulator.js`) |
| `auditor/audit.js` | Omission audit (Algorithm 3 in the paper) |
| `web/` | Web app: MetaMask sign-in, users sign their own record and ACL transactions, client-side verification |
| `contracts/Baselines.sol` | Evaluation baselines: B0 trusted gateway, B1 device secp256k1 signature, B2 device P-256 signature (EIP-7951 precompile) |
| `gateway/baselines.js` | Single-channel gateway for the baselines (same store-then-commit structure, no witness) |
| `shared/http.js` | HTTP keep-alive setting (`KEEPALIVE_MS`) and a counter of new connections |
| `scripts/` | Key generation, deployment, gas report, Azure orchestration, load, cold-start and Sepolia analysis, statistics, figures |
| `test/` | Contract unit tests and the end-to-end attack suite T1–T9 |
| `legacy/` | The original prototype, kept unchanged for reference |

## Quick start (local, no cloud)

Requires Node.js 20 or later.

```bash
npm install
npm run keys                      # .env + devices.json (10 simulated sensors)
npm test                          # 23 contract tests, 4 Key Vault signer tests, attack suite T1–T9 (writes results/attacks_hardhat.csv)
npm run gas                       # gas per operation (writes results/gas_hardhat.csv)

# full stack in separate terminals
npm run chain                     # 1: local Hardhat node
npm run deploy:local              # 2: deploy the contract bound to the witness key
npm run witness:local             # 3: local witness emulator (port 7071)
npm run gateway                   # 4: fog gateway (port 3001)
npm run device -- --n 50 --warmup 10    # 5: store-path latency -> results/latency_localhost.csv
npm run device -- --crypto 1000         #    device-side cost    -> results/device_cost.csv
npm run audit -- --delta 30             #    omission audit
npm run web                       # optional: web app on http://127.0.0.1:8080 (MetaMask on localhost:8545)
```

## Testing

| Command | What it checks | Needs |
|---|---|---|
| `npm test` | 23 contract tests, 4 Key Vault signer tests and the end-to-end attack suite T1–T9 (in-process) | nothing else |
| `npm run test:azure` | The Azure Functions witness code against Azurite (real Table Storage semantics: write once, 404, log) | `npm i --no-save azurite@3` and `cd witness/azure && npm i` |
| `npm run test:web` | Headless browser run of the web app with a MetaMask stand-in: sign-in, registration, PHI, grant/revoke, prescriptions, device-record verification | running chain, witness, gateway, `npm run web`; `npm i --no-save playwright` |
| `npm run check:concurrency -- 20` | 20 devices submit at once; every record is committed exactly once | running chain, witness, gateway |
| `npm run bench:retrieve -- --n 50 --warmup 10` | Retrieval with client-side verification | running chain, witness, gateway |
| `npm run stats -- ...` | Mean, 95% CI, median and p95 from the raw CSVs, written into the paper's `results_values.tex` | CSVs from the benchmarks |

To emulate a public chain's 12 s slots locally, start the node with `HARDHAT_BLOCK_INTERVAL_MS=12000 npm run chain`
and benchmark with `npm run device -- --n 20 --warmup 2 --jitter 12000` (the random pause makes submissions
sample the slot phase instead of locking onto it).

## Azure witness, experiments and Sepolia

`scripts/azure.js` deploys the witness to Azure Functions (Flex Consumption) and runs the experiments with this
machine as the fog node. It needs Node.js 20+ (24 LTS recommended) and the Azure CLI. On Windows, double-click
`RUN_REVISION.cmd`: it keeps the PC awake, uses a portable Node.js 24 LTS (downloaded from nodejs.org and checked
against its SHA-256), installs the packages, signs in to Azure if needed, deploys the witness and runs every
experiment (about 3 hours). `TEARDOWN_AZURE.cmd` deletes everything afterwards. Single steps:

```powershell
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 setup      # copy to %USERPROFILE%\2sdif, npm ci, keys, compile
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 login      # az login, select the Azure for Students subscription
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 preflight  # region allowed by policy and offering Flex Consumption
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 deploy     # resource group, storage, Key Vault, Function App, code
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 revision   # all experiments below
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 teardown   # delete everything on Azure
```

Elsewhere, call `node scripts/azure.js <step>` after `az login`; `node scripts/azure.js revision --only load,audit`
repeats selected experiments.

| Step | Experiment | Output in `results/` (copied to `results_revision/`) |
|---|---|---|
| core | HTTPS round trip and clock offset to the witness; store path (100 trials); retrieval; attack suite against the deployed witness | `rtt_azure.csv`, `latency_azure.csv`, `retrieve_azure.csv`, `attacks_remote.csv` |
| keepalive | connection reuse on/off × back-to-back / 10 s idle readings, with new-connection counts | `ka_{on,off}_gap{0,10}.csv` |
| plain | the device's deposit over plain HTTP vs HTTPS without connection reuse (the deposit and attestation authenticate themselves) | `channel2_{http,https}.csv` |
| load | k deposits at once (1–200), fixed arrival rates (5–100/s), k devices through one gateway (1–100) | `load_witness_burst.csv`, `load_witness_rate.csv`, `load_e2e*.csv` |
| audit | periodic auditor on a 12 s slot chain against a gateway that withholds every 6th and delays every 7th record, with suppressed deposits | `audit_truth.csv`, `audit_watch.csv`, `audit_summary.json` |
| local | contract tests and in-process attacks; gas (Osaka), including batched commitments of 4, 16 and 64 records; device cost (HMAC vs secp256k1 and P-256 signing); baselines B0–B2 on the same chain | `attacks_hardhat.csv`, `gas_hardhat.csv`, `device_cost.csv`, `latency_B{0,1,2}.csv` |
| idle, restarts | witness cold starts after 20 min idle and after app restarts (`x-cold`, `x-instance` headers) | `coldstart.csv` |
| kvsign | attestations signed by a non-exportable P-256K key in Key Vault (`WITNESS_KEY_ID`) instead of a key in memory | `latency_kvsign.csv` |
| sepolia | Sepolia gas for 2SDIF and the baselines; store path with 100 jittered trials; slot analysis | `gas_sepolia.csv`, `latency_sepolia.csv`, `sepolia_blocks.csv`, `sepolia_run.json` |
| metrics | Azure Monitor execution meters over the run, and the app's scale settings | `azure_metrics.json`, `environment.json` |

`results/revision_status.json` records the outcome of each step; a failed step does not stop the others.
`python3 scripts/paper_values.py` turns the results into the paper's macros and `python3 scripts/figures.py`
draws the figures from them.

- **Secrets:** the witness key, the device keys and the Table Storage connection string go to Key Vault through
  temporary files. The Function App reads them through Key Vault references, using its managed identity. Nothing
  secret is written to `azure_run.log`.
- **Binding:** the witness is bound to one deployment (`CHAIN_ID`, `CONTRACT_ADDRESS` app settings) and serves
  attestations and log entries of that deployment only. Each experiment rebinds it to the contract it deploys and
  waits until the health endpoint reports the new binding.
- **Sepolia:** `sepolia-wallet` creates a throwaway admin wallet and prints its address so you can fund it from a
  faucet. `SEPOLIA_RPC_URL` defaults to a public endpoint. Without a funded wallet the Sepolia steps are skipped.
- **Cost:** cents. Flex Consumption bills per execution, and the storage, Key Vault and Application Insights
  usage is small. Run `teardown` when the measurements are done.

## Offline compilation

If your machine cannot download the Solidity compiler, run `npm i --no-save solc@0.8.24` and set
`SOLCJS_PATH=node_modules/solc/soljson.js`.
