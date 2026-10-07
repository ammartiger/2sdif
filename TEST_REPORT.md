# 2SDIF prototype: test report (cloud sandbox, 30 Sep 2026)

**Environment:** Claude's cloud sandbox with 2 vCPU (Intel Xeon @ 2.80 GHz), Ubuntu 24.04, Node.js 22, Hardhat 2.29 and solc 0.8.24 (optimizer 200 runs, Cancun). Everything ran on one machine.

> **These are functional tests and sandbox timings, not the paper's results.** The sandbox cannot reach Azure or Sepolia; its network blocks both. Two stand-ins were used:
> - **Witness:** the local emulator, and the real Azure Functions code backed by Azurite (Microsoft's Table Storage emulator).
> - **Public chain:** a Hardhat node producing a block every 12 s.
>
> Every service ran on the same host, so network latency is near zero. The paper's latency figures must come from your lab PC with the witness deployed in Azure UAE North.

## 1. Results at a glance

| Test | Result |
|---|---|
| Contract unit tests (attestation, write once, replay, access control, prescriptions) | **14/14 pass** |
| End-to-end attack suite T1–T7 (in-process witness, gateway, device, contract) | **7/7 scenarios stopped**, 20/20 runs each |
| Omission audit (T5): 10 of 60 records withheld | **10/10 flagged, 0 false positives** |
| Azure Functions witness code against Azurite Table Storage | **12/12 checks pass** |
| Full stack as separate processes (chain, witness, gateway, device, auditor) | Works; the auditor matches every attested record to its on-chain proof |
| Same stack with the Azure witness code (Azurite-backed) instead of the emulator | Works; the log endpoint refuses requests without the function key (401) |
| Concurrency: 20 and 50 simultaneous device submissions | **All committed** (after the fixes below) |
| 12 s slot emulation: store path, concurrency, auditor inclusion bound | Works (see §3) |
| Web app in headless Chromium with a MetaMask stand-in | **22/22 checks pass** (see §4) |
| Statistics pipeline (CSV → mean, 95% CI, median, p95 → `results_values.tex`) | Works; t-quantile checked (t₀.₉₇₅,₄₉ = 2.0096) |

## 2. Bugs found and fixed during testing

1. **The gateway crashed under concurrent load.**
   - *Cause:* two writes to the same local store file raced on a shared temporary file, and Express 4 does not catch errors from async handlers, so the process exited.
   - *Fix:* writes to each collection are serialized with unique temporary files. Every async route is wrapped, and an error handler returns a 500 response instead of exiting.
2. **The gateway could stall its own transactions.**
   - *Cause:* ethers' `NonceManager` uses up a nonce even when a transaction fails before sending (for example, a revert during gas estimation). On an auto-mining chain the following transactions then wait forever.
   - *Fix:* gateway transactions are sent one at a time, and a failed send resets the nonce manager. Waiting for receipts still happens in parallel.
3. **"Nonce too low" when one script sent two transactions back to back.**
   - *Cause:* ethers v6 briefly caches `eth_getTransactionCount`.
   - *Fix:* response caching is disabled (`cacheTimeout: -1`) in the gateway and benchmark providers.
4. **Sensors and web app derived patient ids differently.**
   - *Cause:* sensors used `keccak("patient-01")` while the web app used `keccak("<salt>:<national id>")`.
   - *Fix:* both now use the salted rule, so a patient registered in the web app can read their own sensor's records.
5. **Benchmark method: sequential submissions lock onto the block schedule.** With 12 s blocks and no pause between trials, every commit took about 12.3 s (11.3–12.3 s), because each trial started just after a block. The simulator now takes `--jitter 12000` (a random pause before each trial). With it, commit latency spread over 1.15–12.31 s (median 5.2 s), which is what the paper's Sepolia paragraph describes. **Use `--jitter` for the Sepolia run.**
6. **Test layout:** the Azure check lived in `test/` and stopped mocha early. It moved to `scripts/check-azure-witness.js`.
7. **Web app:** long record JSON now wraps in the verification panel.

## 3. Sandbox timings (for sanity only; not the paper's values)

Store path: 50 trials after 10 warm-up; mean, 95% CI, median, p95, all in ms.

| Run | Step | Mean | 95% CI | Median | p95 |
|---|---|---|---|---|---|
| A: local witness emulator | Witness deposit | 3.6 | ±0.2 | 3.3 | 4.9 |
| | Transfer to gateway | 2.0 | ±0.1 | 2.0 | 2.7 |
| | Attestation retrieval | 1.4 | ±0.1 | 1.3 | 2.1 |
| | Gateway verification (hash + signature recovery) | 3.4 | ±0.3 | 3.0 | 5.4 |
| | Commit on Hardhat (send + receipt) | 99.9 | ±1.8 | 98.1 | 109.3 |
| | Local persistence | 1.5 | ±0.3 | 1.2 | 3.7 |
| | **Store, end to end** | **112.0** | ±1.9 | 112.9 | 120.7 |
| B: Azure witness code + Azurite | Witness deposit | 6.2 | ±0.4 | 5.7 | 8.3 |
| | Attestation retrieval | 3.5 | ±0.2 | 3.3 | 4.6 |
| | **Store, end to end** | **118.7** | ±2.7 | 114.9 | 135.4 |
| E: retrieval | Read + authorization + client verification | 30.6 | ±0.7 | 30.1 | 35.4 |

**What these runs show:**

- **Commit dominates the local chain.** About 100 ms goes to Hardhat's JSON-RPC handling (gas estimation, send, receipt polling), not consensus.
- **The witness runs are pure computation.** On the same host they cost only 4–10 ms. On your PC with Azure UAE North, the network round trip will dominate them.
- **Public-chain emulation (12 s blocks, 20 trials, `--jitter 12000`):** commit took a median of 5.2 s (range 1.15–12.31 s). With a 1 s receipt poll, the end to end median was 5.2 s.
- **Auditor inclusion bound under 12 s blocks:**
  - With Δ = 0, the 5 records still waiting for a block were flagged: false positives, as the paper predicts.
  - With Δ = 30 s, nothing was flagged.
  - After inclusion, nothing was flagged even with Δ = 0.
- **Device cost (1,000 records of 320 bytes):**
  - Digest, including canonical JSON serialization: mean 14.1 µs (median 9.0).
  - HMAC: mean 9.0 µs (median 7.4).
  - Total: mean 23.2 µs (median 16.7).
- **Gas from receipts:**

  | Operation | Gas |
  |---|---|
  | Deployment | 1,462,233 |
  | `commitProof` | 100,807–100,831 (varies with calldata bytes) |
  | Register clinician | 70,310 |
  | Register patient | 118,438 |
  | Add PHI record | 96,137 |
  | Grant PHI access | 51,095 |
  | Revoke PHI access | 29,138 |
  | Add prescription | 96,196 |
  | Grant Rx access | 51,131 |
  | Revoke Rx access | 29,164 |

## 4. Web app end-to-end checks (headless Chromium)

MetaMask was replaced by a minimal provider that forwards requests to the Hardhat node's unlocked accounts. Every sign-in and transaction therefore went through the chain and the gateway for real.

1. **Administrator:**
   - signs in with a nonce and signature, with no transaction;
   - registers a clinician;
   - registers the patient monitored by sensor-01.
2. **Outsider** signs in and tries to grant itself access. **The contract reverts the attempt.**
3. **Clinician:**
   - commits and stores a health information record;
   - grants a doctor access.
4. **Doctor** reads the record. **It verifies against the chain.**
5. **Clinician** revokes the doctor. **The doctor's next read returns 403 AccessDenied.**
6. **Prescription path:**
   - the clinician commits a prescription and grants a medical store access;
   - the store reads it, and **it verifies**.
7. **Device path:** sensor-01 stores a reading through the dual channel. The patient reads it in the browser, and **it verifies against the witness-attested proof**.

Screenshot: `sandbox_test_results/web_e2e.png`.

## 5. Not testable here (next step, on your PC)

- **Real Azure deployment:** Flex Consumption app, Key Vault references, function-key auth enforced by the Functions host, cold starts, and the execution times Azure reports for the paper's `WitExecMed`.
- **Real Sepolia:** fee market, proposer delays, and a gas spot check.
- **Network latency** from Islamabad to UAE North, and the latency figures that go into the paper.
- **MetaMask itself:** the extension's pop-ups. The tests used a stand-in provider.
