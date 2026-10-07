# 2SDIF prototype (v2)

Serverless dual channel witness for accountable fog oracles, demonstrated on a smart healthcare scenario.
This version implements the design described in the Journal of Systems Architecture draft.

2SDIF is an accountable fog oracle. A device sends each record over two channels: the record itself goes through
the fog to the gateway, while an HMAC-authenticated digest of it goes directly to a serverless witness. The
witness signs an attestation of the digest it received, and the smart contract verifies that attestation before it
accepts the gateway's commitment, so a fog node that alters a record in transit is stopped on chain and one that
withholds a record is exposed by an audit of the witness log.

**Paper:** "2SDIF: A Serverless Dual Channel Oracle for Data in Transit Integrity in Blockchain Enabled Fog IoT
Systems" (under review, Journal of Systems Architecture). To cite this repository, see [CITATION.cff](CITATION.cff).

## Reproducing the paper

- **Numbers:** [paper_results/README.md](paper_results/README.md) describes the raw per-trial measurements in
  `paper_results/` and gives the one `scripts/stats.js` command that regenerates every number in the paper from them.
- **Tests:** `npm test` runs the 14 contract tests and the end-to-end attack suite T1–T7 (22 passing tests), with
  no cloud account.
- **Azure and Sepolia runs:** `scripts/azure.js` (wrapped by `run_azure.ps1` on Windows) deploys the witness to
  your own Azure subscription and reruns the benchmarks; see [Azure witness and Sepolia](#azure-witness-and-sepolia).
  The resources used for the paper's measurements have been deleted.

## Security note

This repository contains no keys. `npm run keys` generates them locally into `.env` and `devices.json`, which are
git-ignored; never commit either file. Use throwaway wallets on public testnets.

## Architecture

```
device ──(channel 2: did, rid, SHA-256 digest, HMAC tag)──► witness (Azure Functions) ── signed attestation
   │                                                                                    │
   └──(channel 1: record)──► fog member ──► fog gateway ── commitProof(rid, h, did, tW, σW) ──► contract
                                                                                   (verifies σW with ecrecover)
auditor: witness log  vs  ProofCommitted events  → flags withheld records
```

## Layout

| Path | What it is |
|---|---|
| `contracts/TwoSDIFRegistry.sol` | Witness-verified proofs (`commitProof`), registration, PHI and prescription records, contract-enforced ACLs |
| `shared/protocol.js` | Canonical JSON, SHA-256 digest, HMAC tag, attestation message (identical to the contract) |
| `witness/core.js` | Witness logic: verify HMAC, write once, sign attestation, serve log |
| `witness/azure/` | Azure Functions app (Flex Consumption) using Table Storage; secrets from Key Vault |
| `witness/local-server.js` | Local emulator with the same routes, for dry runs |
| `gateway/` | Fog gateway (Express): early check, `commitProof`, record store, authenticated reads |
| `device/` | Sensor simulator (`device.js`) and benchmark CLI (`simulator.js`) |
| `auditor/audit.js` | Omission audit (Algorithm 3 in the paper) |
| `web/` | Web app: MetaMask sign-in, users sign their own record and ACL transactions, client-side verification |
| `scripts/` | Key generation, deployment, gas report, Azure packaging |
| `test/` | Contract unit tests and the end-to-end attack suite T1–T7 |
| `legacy/` | The original prototype, kept unchanged for reference |

## Quick start (local, no cloud)

Requires Node.js 20 or later.

```bash
npm install
npm run keys                      # .env + devices.json (10 simulated sensors)
npm test                          # 14 contract tests + attack suite T1–T7 (writes results/attacks_hardhat.csv)
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
| `npm test` | 14 contract tests and the end-to-end attack suite T1–T7 (in-process) | nothing else |
| `npm run test:azure` | The Azure Functions witness code against Azurite (real Table Storage semantics: write once, 404, log) | `npm i --no-save azurite@3` and `cd witness/azure && npm i` |
| `npm run test:web` | Headless browser run of the web app with a MetaMask stand-in: sign-in, registration, PHI, grant/revoke, prescriptions, device-record verification | running chain, witness, gateway, `npm run web`; `npm i --no-save playwright` |
| `npm run check:concurrency -- 20` | 20 devices submit at once; every record is committed exactly once | running chain, witness, gateway |
| `npm run bench:retrieve -- --n 50 --warmup 10` | Retrieval with client-side verification | running chain, witness, gateway |
| `npm run stats -- ...` | Mean, 95% CI, median and p95 from the raw CSVs, written into the paper's `results_values.tex` | CSVs from the benchmarks |

To emulate a public chain's 12 s slots locally, start the node with `HARDHAT_BLOCK_INTERVAL_MS=12000 npm run chain`
and benchmark with `npm run device -- --n 20 --warmup 2 --jitter 12000` (the random pause makes submissions
sample the slot phase instead of locking onto it).

## Azure witness and Sepolia

`scripts/azure.js` deploys the witness to Azure Functions (Flex Consumption) and runs the benchmarks with this
machine as the fog node. It needs Node.js 20+ and the Azure CLI. On Windows, `run_azure.ps1` wraps every step:

```powershell
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 check      # tools and host details
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 setup      # copy to %USERPROFILE%\2sdif, npm ci, keys, compile
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 login      # az login, select the Azure for Students subscription
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 preflight  # region allowed by policy and offering Flex Consumption
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 deploy     # resource group, storage, Key Vault, Function App, code
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 bench      # store, retrieval, RTT, device cost, attacks, gas
powershell -ExecutionPolicy Bypass -File .\run_azure.ps1 teardown   # delete everything on Azure
```

Elsewhere, call `node scripts/azure.js <step>` directly after `az login`.

- **Secrets:** the witness key, the device keys and the Table Storage connection string go to Key Vault through
  temporary files. The Function App reads them through Key Vault references, using its managed identity. Nothing
  secret is written to `azure_run.log`.
- **Binding:** the witness is bound to one deployment (`CHAIN_ID`, `CONTRACT_ADDRESS` app settings). `bench` and
  `sepolia` rebind it to the contract they deploy and wait until the health endpoint reports the new binding.
- **Results** (`results/`, copied to `results_azure/` by the Windows runner):

  | File | Contents |
  |---|---|
  | `latency_azure.csv` | per-trial store breakdown, including the witness's own handler time (`x-exec-ms`) for deposit and attestation |
  | `retrieve_azure.csv` | retrieval with client-side verification |
  | `rtt_azure.csv` | HTTPS round trip to the witness health endpoint |
  | `attacks_remote.csv` | T1–T7 against the deployed witness |
  | `attacks_hardhat.csv` | T1–T7 in-process |
  | `gas_hardhat.csv`, `device_cost.csv`, `environment.json` | gas per operation, device-side cost, host details |
  | `results_values_azure.tex` | the paper's macros, from `scripts/stats.js` |

- **Sepolia:** `sepolia-wallet` creates a throwaway admin wallet and prints its address so you can fund it from a
  faucet (about 0.1 SepoliaETH). `sepolia` then deploys the contract, tops up the gateway, rebinds the witness and
  runs 20 jittered commits. `SEPOLIA_RPC_URL` defaults to a public endpoint.
- **Cost:** a few cents per day. Flex Consumption bills per execution, and the storage, Key Vault and Application
  Insights usage is small. Run `teardown` when the measurements are done.

## Offline compilation

If your machine cannot download the Solidity compiler, run `npm i --no-save solc@0.8.24` and set
`SOLCJS_PATH=node_modules/solc/soljson.js`.
