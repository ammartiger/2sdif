#!/usr/bin/env python3
"""
Every number the paper quotes, computed from the raw result files.

    python3 scripts/paper_values.py --results results --out results/paper_values.tex

Writes LaTeX macros (\\newcommand{\\Name}{value}) and a JSON twin (paper_values.json). A value whose input
file is missing is written as \\pending{Name}, which the paper typesets in red, so nothing unmeasured can
slip into a submitted version.
Statistics: mean with a 95% t confidence interval, median and 95th percentile (linear interpolation).
Macro names contain letters only (LaTeX); B0/B1/B2 are spelled Bzero/Bone/Btwo, p95 is Pnf.
"""
import argparse
import json
import math
import os

import numpy as np
import pandas as pd

try:
    from scipy import stats as sps
except Exception:  # scipy is optional; fall back to a normal quantile for large n
    sps = None

V = {}


def texesc(x):
    return None if x is None else str(x).replace("\\", "/").replace("&", "\\&").replace("%", "\\%").replace("#", "\\#").replace("_", "\\_").replace("$", "\\$")


def put(name, value):
    assert name.isalpha(), name
    V[name] = value


def puts(name, value):
    """A free-text value (host names, versions): escaped for LaTeX."""
    put(name, texesc(value))


def pending(*names):
    for n in names:
        V.setdefault(n, None)


def read(res, f):
    p = os.path.join(res, f)
    return pd.read_csv(p) if os.path.exists(p) else None


def fmt(x, d=1):
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    x = float(x)
    if abs(x) >= 100:
        return f"{x:,.0f}".replace(",", "{,}")
    return f"{x:.{d}f}"


def tq(n):
    if n < 2:
        return float("nan")
    if sps is not None:
        return float(sps.t.ppf(0.975, n - 1))
    return 1.96


def summ(prefix, v, d=1):
    v = np.asarray(pd.to_numeric(pd.Series(v), errors="coerce").dropna(), dtype=float)
    if len(v) == 0:
        return pending(*(prefix + s for s in ["Mean", "CI", "Med", "Pnf", "Min", "Max"]))
    m = v.mean()
    ci = tq(len(v)) * v.std(ddof=1) / math.sqrt(len(v)) if len(v) > 1 else float("nan")
    put(prefix + "Mean", fmt(m, d))
    put(prefix + "CI", fmt(ci, d))
    put(prefix + "Med", fmt(np.percentile(v, 50), d))
    put(prefix + "Pnf", fmt(np.percentile(v, 95), d))
    put(prefix + "Min", fmt(v.min(), d))
    put(prefix + "Max", fmt(v.max(), d))
    return v


def thousands(x):
    return f"{int(round(float(x))):,}".replace(",", "{,}")


WORD = {0: "Zero", 1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 10: "Ten", 16: "Sixteen", 20: "Twenty", 50: "Fifty", 64: "SixtyFour", 100: "Hundred", 200: "TwoHundred"}


def word(n):
    return WORD.get(int(n), "N" + "".join("abcdefghij"[int(c)] for c in str(int(n))))


def core(res):
    s = read(res, "latency_azure.csv")
    cols = {"EE": "e2eMs", "Dep": "depositMs", "Lan": "transferMs", "Fetch": "fetchMs", "Ver": "verifyMs", "Com": "commitMs", "Per": "persistMs", "DepExec": "depositExecMs", "FetchExec": "fetchExecMs"}
    if s is None:
        for k in cols:
            summ(k, [])
        return pending("NTrials")
    for k, c in cols.items():
        summ(k, s[c])
    put("NTrials", str(len(s)))
    put("DepConnsMean", fmt(s.depositConns.mean(), 2))
    put("FetchConnsMean", fmt(s.fetchConns.mean(), 2))
    put("FetchAttemptsMax", str(int(s.fetchAttempts.max())))
    g = s.gasUsed.astype(float)
    put("GasCommitLocalMin", thousands(g.min()))
    put("GasCommitLocalMax", thousands(g.max()))
    r = read(res, "rtt_azure.csv")
    if r is not None:
        summ("Rtt", r.rttMs)
        summ("RttExec", r.execMs)
        if "offsetMs" in r:
            off = pd.to_numeric(r.offsetMs, errors="coerce").dropna()
            put("ClockOffsetMed", fmt(off.median() / 1000, 1))
            put("ClockOffsetMaxAbs", fmt(off.abs().max() / 1000, 1))
    rt = read(res, "retrieve_azure.csv")
    if rt is not None:
        summ("Ret", rt.retrieveMs)


def baselines(res):
    s = read(res, "latency_azure.csv")
    names = {"B0": "Bzero", "B1": "Bone", "B2": "Btwo"}
    meds = {}
    for m, w in names.items():
        b = read(res, f"latency_{m}.csv")
        if b is None:
            summ(w + "EE", [])
            continue
        meds[m] = float(b.e2eMs.median())
        summ(w + "EE", b.e2eMs)
        summ(w + "Com", b.commitMs)
        summ(w + "Ver", b.verifyMs, 2)
        summ(w + "Lan", b.transferMs)
        put(w + "SignMedUs", fmt(b.signMs.median() * 1000, 0))
    if s is not None and "B0" in meds:
        d = float(s.e2eMs.median()) - meds["B0"]
        put("OverheadVsBzeroMs", fmt(d, 1))
        put("OverheadVsBzeroPct", fmt(100 * d / meds["B0"], 0))
    if s is not None and "B1" in meds:
        put("OverheadVsBoneMs", fmt(float(s.e2eMs.median()) - meds["B1"], 1))


def device(res):
    d = read(res, "device_cost.csv")
    if d is None:
        return pending("DevHashMed", "DevHmacMed", "DevTotalMed", "DevSecpMed", "DevPMed", "RecBytes")
    put("DevHashMed", fmt(d.hashUs.median(), 1))
    put("DevHmacMed", fmt(d.hmacUs.median(), 1))
    put("DevTotalMed", fmt(d.totalUs.median(), 1))
    put("DevSecpMed", fmt(d.secp256k1SignUs.median(), 0))
    put("DevPMed", fmt(d.p256SignUs.median(), 0))
    put("RecBytes", str(int(d.bytes.median())))
    put("NDevTrials", str(len(d)))


def gas(res, f, tag):
    g = read(res, f)
    keys = {
        ("2SDIF", "Contract deployment"): "Deploy", ("2SDIF", "Register clinician"): "RegClin", ("2SDIF", "Register patient"): "RegPat",
        ("2SDIF", "Attested commitment (commitProof)"): "Commit", ("2SDIF", "Add health information record"): "AddPhi",
        ("2SDIF", "Grant health information access"): "GrantPhi", ("2SDIF", "Revoke health information access"): "RevokePhi",
        ("2SDIF", "Add prescription"): "AddRx", ("2SDIF", "Grant prescription access"): "GrantRx", ("2SDIF", "Revoke prescription access"): "RevokeRx",
        ("B0", "Contract deployment"): "BzeroDeploy", ("B0", "Commitment (trusted gateway)"): "BzeroCommit",
        ("B1", "Contract deployment"): "BoneDeploy", ("B1", "Register device key"): "BoneReg", ("B1", "Commitment (device secp256k1 signature)"): "BoneCommit",
        ("B2", "Contract deployment"): "BtwoDeploy", ("B2", "Register device key"): "BtwoReg", ("B2", "Commitment (device P-256 signature)"): "BtwoCommit",
    }
    for k in (4, 16, 64):
        keys[("2SDIF-batch", f"Batched commitment k={k} (per record)")] = f"Batch{word(k)}Per"
        keys[("2SDIF-batch", f"Batched commitment k={k} (transaction)")] = f"Batch{word(k)}Tx"
    if g is None:
        return pending(*(f"Gas{tag}{v}" for v in keys.values()))
    for _, r in g.iterrows():
        k = keys.get((r.design, r.operation))
        if k:
            put(f"Gas{tag}{k}", thousands(r.gasUsed))
            if isinstance(r["min"], (int, float)) and not pd.isna(r["min"]):
                put(f"Gas{tag}{k}Min", thousands(r["min"]))
                put(f"Gas{tag}{k}Max", thousands(r["max"]))
    gg = {k: float(r.gasUsed) for k, r in ((keys.get((r.design, r.operation)), r) for _, r in g.iterrows()) if k}
    if "Commit" in gg and "BzeroCommit" in gg:
        put(f"Gas{tag}OverBzero", thousands(gg["Commit"] - gg["BzeroCommit"]))
    if "Commit" in gg and "BoneCommit" in gg:
        put(f"Gas{tag}OverBone", thousands(gg["Commit"] - gg["BoneCommit"]))


def keepalive(res):
    for ka in ["on", "off"]:
        for gap in ["0", "10"]:
            d = read(res, f"ka_{ka}_gap{gap}.csv")
            w = ("KaOn" if ka == "on" else "KaOff") + ("Busy" if gap == "0" else "Idle")
            if d is None:
                pending(w + "DepMed", w + "FetchMed", w + "EEMed", w + "DepConns", w + "FetchConns")
                continue
            put(w + "DepMed", fmt(d.depositMs.median(), 1))
            put(w + "FetchMed", fmt(d.fetchMs.median(), 1))
            put(w + "EEMed", fmt(d.e2eMs.median(), 1))
            put(w + "DepConns", fmt(d.depositConns.mean(), 2))
            put(w + "FetchConns", fmt(d.fetchConns.mean(), 2))
            put(w + "N", str(len(d)))


def extras(res):
    """Deposits over plain HTTP vs HTTPS (no reuse), and attestations signed in Key Vault."""
    for name, w in [("https", "ChanTls"), ("http", "ChanPlain")]:
        d = read(res, f"channel2_{name}.csv")
        if d is None:
            pending(w + "DepMed")
            continue
        put(w + "DepMed", fmt(d.depositMs.median(), 1))
        put(w + "DepPnf", fmt(np.percentile(d.depositMs, 95), 1))
        put(w + "DepExecMed", fmt(d.depositExecMs.median(), 1))
        put(w + "DepConns", fmt(d.depositConns.mean(), 2))
        put(w + "N", str(len(d)))
    k = read(res, "latency_kvsign.csv")
    if k is None:
        return pending("KvDepExecMed", "KvDepMed", "KvEEMed")
    summ("KvDep", k.depositMs)
    summ("KvDepExec", k.depositExecMs)
    summ("KvEE", k.e2eMs)
    put("NKv", str(len(k)))
    s = read(res, "latency_azure.csv")
    if s is not None:
        put("KvExecOverMemMs", fmt(k.depositExecMs.median() - s.depositExecMs.median(), 1))


def load(res):
    b = read(res, "load_witness_burst.csv")
    if b is not None:
        for lv in sorted(b.level.unique()):
            sel = b[b.level == lv]
            ok = sel[sel.status == 201]
            w = "Burst" + word(lv)
            put(w + "Med", fmt(ok.latencyMs.median(), 0))
            put(w + "Pnf", fmt(np.percentile(ok.latencyMs, 95), 0) if len(ok) else None)
            put(w + "Inst", str(sel.instance.nunique()))
            put(w + "Fail", str(int((sel.status != 201).sum())))
            put(w + "Wall", fmt(sel.wallMs.median(), 0))
        put("BurstMaxLevel", str(int(b.level.max())))
        put("BurstTotalFail", str(int((b.status != 201).sum())))
        put("BurstTotal", str(len(b)))
    r = read(res, "load_witness_rate.csv")
    if r is not None:
        for rv in sorted(r.rate.unique()):
            sel = r[r.rate == rv]
            ok = sel[sel.status == 201]
            w = "Rate" + word(rv)
            put(w + "Med", fmt(ok.latencyMs.median(), 0))
            put(w + "Pnf", fmt(np.percentile(ok.latencyMs, 95), 0) if len(ok) else None)
            put(w + "Inst", str(sel.instance.nunique()))
            put(w + "Fail", str(int((sel.status != 201).sum())))
            put(w + "LagMax", fmt(sel.lagMs.max(), 0))
            put(w + "N", str(len(sel)))
        put("RateTotal", str(len(r)))
        put("RateTotalFail", str(int((r.status != 201).sum())))
        put("RateMax", str(int(r.rate.max())))
        put("RateInstMax", str(r[r.rate == r.rate.max()].instance.nunique()))
    s = read(res, "load_e2e_summary.csv")
    e = read(res, "load_e2e.csv")
    if s is not None:
        for _, row in s.iterrows():
            w = "Load" + word(row.devices)
            put(w + "Tput", fmt(row.throughputPerSec, 1))
            put(w + "Committed", str(int(row.committed)))
            put(w + "Records", str(int(row.records)))
            if e is not None:
                sel = e[(e.devices == row.devices) & (e.ok == 1)]
                put(w + "EEMed", fmt(sel.e2eMs.median(), 0))
                put(w + "EEPnf", fmt(np.percentile(sel.e2eMs, 95), 0) if len(sel) else None)
                put(w + "ComMed", fmt(sel.commitMs.median(), 0))
                put(w + "DepMed", fmt(sel.depositMs.median(), 0))
        put("LoadMaxTput", fmt(s.throughputPerSec.max(), 1))
        put("LoadMaxDevices", str(int(s.devices.max())))
        if e is not None:
            put("LoadTotalFail", str(int((e.ok == 0).sum())))


def audit(res):
    p = os.path.join(res, "audit_summary.json")
    if not os.path.exists(p):
        return pending("AuditReadings", "AuditFP", "AuditFN")
    a = json.load(open(p))
    put("AuditReadings", str(a["readings"]))
    for k, w in [("committed", "Committed"), ("withheld", "Withheld"), ("delayed", "Delayed"), ("suppressed", "Suppressed")]:
        put("Audit" + w, str(a["outcomes"].get(k, 0)))
    put("AuditFP", str(a["falsePositives"]))
    put("AuditFN", str(a["falseNegatives"]))
    put("AuditOther", str(a["otherFlags"]))
    par = a["parameters"]
    put("AuditDelta", str(par["deltaSec"]))
    put("AuditSkew", str(par["skewSec"]))
    put("AuditPeriod", str(par["periodSec"]))
    put("AuditBound", str(par["omissionDetectionBoundSec"]))
    for k, w in [("withheldAsOmitted", "Omit"), ("delayedAsLate", "Late"), ("delayedFirstAsOmitted", "LateOmit"), ("suppressedAsGap", "Gap")]:
        d = a["detectionDelaySec"].get(k)
        if d:
            put("Audit" + w + "Min", fmt(d["min"], 0))
            put("Audit" + w + "Med", fmt(d["median"], 0))
            put("Audit" + w + "Max", fmt(d["max"], 0))
        else:
            pending("Audit" + w + "Med")
    put("AuditReceiptsValid", str(a["receipts"]["valid"]))
    put("AuditReceiptsRequired", str(a["receipts"]["required"]))


def cold(res):
    c = read(res, "coldstart.csv")
    if c is None:
        return pending("ColdIdleFirst", "ColdRestartFirstMed")
    idle = c[c.label.str.startswith("idle")]
    rst = c[c.label.str.startswith("restart")]
    if len(idle):
        put("ColdIdleN", str(len(idle)))
        put("ColdIdleFirstMin", fmt(idle.firstMs.min(), 0))
        put("ColdIdleFirstMax", fmt(idle.firstMs.max(), 0))
        put("ColdIdleColdCount", str(int((idle.firstCold.astype(str) == "1").sum())))
        put("ColdIdleMinutes", fmt(idle.idleSec.astype(float).median() / 60, 0))
    if len(rst):
        put("ColdRestartN", str(len(rst)))
        put("ColdRestartFirstMed", fmt(rst.firstMs.median(), 0))
        put("ColdRestartFirstMin", fmt(rst.firstMs.min(), 0))
        put("ColdRestartFirstMax", fmt(rst.firstMs.max(), 0))
        put("ColdRestartColdCount", str(int((rst.firstCold.astype(str) == "1").sum())))
        put("ColdRestartUntilOkMax", fmt(rst.untilFirstOkMs.max() / 1000, 1))
    put("ColdWarmMed", fmt(c.warmMedianMs.median(), 0))
    put("ColdWarmNewConnMed", fmt(c.warmNewConnMs.median(), 0))


def sepolia(res):
    s = read(res, "latency_sepolia.csv")
    if s is None:
        return pending("SepEEMed", "SepComMed", "NSep")
    put("NSep", str(len(s)))
    v = summ("SepEE", s.e2eMs / 1000, 1)
    summ("SepCom", s.commitMs / 1000, 1)
    summ("SepDep", s.depositMs, 0)
    summ("SepFetch", s.fetchMs, 0)
    g = s.gasUsed.astype(float)
    put("SepGasCommitMed", thousands(g.median()))
    put("SepGasCommitMin", thousands(g.min()))
    put("SepGasCommitMax", thousands(g.max()))
    b = read(res, "sepolia_blocks.csv")
    if b is not None:
        w = b.slotsWaited.astype(int)
        put("SepSlotOne", str(int((w == 1).sum())))
        put("SepSlotTwo", str(int((w == 2).sum())))
        put("SepSlotMore", str(int((w >= 3).sum())))
        put("SepSlotOnePct", fmt(100 * (w == 1).mean(), 0))
        put("SepInclMed", fmt(b.inclusionSec.median(), 1))
        put("SepReceiptLagMed", fmt(b.receiptLagSec.median(), 1))
        put("SepReceiptLagPnf", fmt(np.percentile(b.receiptLagSec, 95), 1))
        put("SepPhaseCorr", fmt(np.corrcoef(b.slotPhaseSec, b.commitSec)[0, 1], 2))
    p = os.path.join(res, "sepolia_run.json")
    if os.path.exists(p):
        j = json.load(open(p))
        put("SepGasDeploy", thousands(j["deployGas"]))
        put("SepFailedAttempts", str(j.get("failedAttempts", 0)))
        put("SepStartHead", thousands(j["startHead"]))
        put("SepEndHead", thousands(j["endHead"]))
        puts("SepFeeCap", j.get("feeCapGwei"))
        puts("SepContract", j.get("contract"))
        puts("SepDate", j.get("finishedAt", "")[:10])


def attacks(res):
    for f, tag in [("attacks_remote.csv", "Remote"), ("attacks_hardhat.csv", "Local")]:
        a = read(res, f)
        if a is None:
            continue
        ok = all(a.runs == a.stopped)
        put(f"Attacks{tag}AllStopped", "yes" if ok else "no")
        put(f"Attacks{tag}Runs", str(int(a.runs.sum())))
        put(f"Attacks{tag}Stopped", str(int(a.stopped.sum())))


def azure(res):
    p = os.path.join(res, "azure_metrics.json")
    if os.path.exists(p):
        m = json.load(open(p))
        sc = m.get("scaleAndConcurrency") or {}
        if sc.get("instanceMemoryMB"):
            put("AzMemMB", thousands(sc["instanceMemoryMB"]))
        if sc.get("maximumInstanceCount"):
            put("AzMaxInst", str(sc["maximumInstanceCount"]))
        http = ((sc.get("triggers") or {}).get("http") or {}).get("perInstanceConcurrency")
        if http:
            put("AzHttpConc", str(http))
        for series in ((m.get("metrics") or {}).get("value") or []):
            name = series["name"]["value"]
            tot = sum((d.get("total") or 0) for ts in series.get("timeseries", []) for d in ts.get("data", []))
            short = {"OnDemandFunctionExecutionCount": "AzExecCount", "OnDemandFunctionExecutionUnits": "AzExecUnits", "Requests": "AzRequests"}.get(name)
            if short:
                put(short, thousands(tot))
    e = os.path.join(res, "environment.json")
    if os.path.exists(e):
        j = json.load(open(e))
        puts("EnvCpu", (j["host"].get("cpu") or "").replace("(R)", "").replace("(TM)", "").replace("  ", " ").strip())
        put("EnvCores", str(j["host"].get("cores")))
        put("EnvMem", fmt(j["host"].get("memoryGiB"), 0))
        puts("EnvNode", j.get("node", "").lstrip("v"))
        puts("EnvHardhat", j.get("hardhat", ""))
        puts("EnvRegion", {"uaenorth": "UAE North"}.get((j.get("azure") or {}).get("region") or "", (j.get("azure") or {}).get("region") or ""))
        if j.get("devices"):
            put("NDevices", str(j["devices"]))
        if j.get("recordedAt"):
            put("RunDate", j["recordedAt"][:10])


# Cost-model parameters (sources in the paper): Ethereum mainnet, first week of October 2026
BLOCK_GAS, SLOT_S = 60_000_000, 12
GWEI_LOW, GWEI_HIGH, USD_PER_ETH = 0.15, 1.13, 2681.0
AZ_GBS_USD, AZ_EXEC_USD = 0.000026, 0.40 / 1e6       # Flex Consumption on-demand meters
TABLE_TX_USD = 0.00036 / 1e4                          # Table Storage, per transaction


def cost_model(res):
    g = read(res, "gas_hardhat.csv")
    if g is None:
        return pending("MaxTputSingle", "MaxTputBatch", "UsdSingleLow", "UsdSingleHigh", "UsdBatchLow", "UsdBatchHigh")
    gas = {(r.design, r.operation): float(r.gasUsed) for _, r in g.iterrows()}
    single = gas.get(("2SDIF", "Attested commitment (commitProof)"))
    batch = gas.get(("2SDIF-batch", "Batched commitment k=64 (per record)"))
    usd = lambda gu, gwei: gu * gwei * 1e-9 * USD_PER_ETH
    if single:
        put("MaxTputSingle", fmt(BLOCK_GAS / (single * SLOT_S), 0))
        put("UsdSingleLow", f"{usd(single, GWEI_LOW):.3f}")
        put("UsdSingleHigh", f"{usd(single, GWEI_HIGH):.2f}")
        put("UsdChainPerMillionLow", thousands(usd(single, GWEI_LOW) * 1e6))
    if batch:
        put("MaxTputBatch", fmt(BLOCK_GAS / (batch * SLOT_S), 0))
        put("UsdBatchLow", f"{usd(batch, GWEI_LOW):.4f}")
        put("UsdBatchHigh", f"{usd(batch, GWEI_HIGH):.3f}")
    p = os.path.join(res, "azure_metrics.json")
    if os.path.exists(p):
        m = json.load(open(p))
        tot = {}
        for series in ((m.get("metrics") or {}).get("value") or []):
            tot[series["name"]["value"]] = sum((d.get("total") or 0) for ts in series.get("timeseries", []) for d in ts.get("data", []))
        n, units = tot.get("OnDemandFunctionExecutionCount"), tot.get("OnDemandFunctionExecutionUnits")
        if n and units:
            gbs_per_exec = units / n / 1000 / 1024        # MB-ms -> GB-s
            per_record = 2 * (gbs_per_exec * AZ_GBS_USD + AZ_EXEC_USD + TABLE_TX_USD)
            put("AzGbsPerExec", f"{gbs_per_exec:.3f}")
            put("UsdWitnessPerMillion", thousands(per_record * 1e6))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results")
    ap.add_argument("--out", default="results/paper_values.tex")
    a = ap.parse_args()
    for f in (core, baselines, device, keepalive, extras, load, audit, cold, sepolia, attacks, azure, cost_model):
        try:
            f(a.results)
        except Exception as e:
            print(f"[values] {f.__name__} failed: {e}")
    gas(a.results, "gas_hardhat.csv", "")
    gas(a.results, "gas_sepolia.csv", "Sep")
    lines = ["% Generated by scripts/paper_values.py from the raw results. Do not edit by hand.",
             "\\providecommand{\\pending}[1]{\\textcolor{red}{[#1]}}"]
    for k in sorted(V):
        v = V[k]
        lines.append(f"\\newcommand{{\\{k}}}{{{v if v is not None else chr(92) + 'pending{' + k + '}'}}}")
    with open(a.out, "w") as fh:
        fh.write("\n".join(lines) + "\n")
    with open(os.path.splitext(a.out)[0] + ".json", "w") as fh:
        json.dump(V, fh, indent=1)
    missing = [k for k, v in V.items() if v is None]
    print(f"[values] {len(V)} values written to {a.out}; {len(missing)} pending" + (f": {', '.join(missing[:20])}" if missing else ""))


if __name__ == "__main__":
    main()
