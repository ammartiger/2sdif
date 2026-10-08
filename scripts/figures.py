#!/usr/bin/env python3
"""
Figures for the paper, drawn from the raw result files (no numbers are typed in by hand).

    python3 scripts/figures.py --results results --out figs

Writes PDF (vector) figures sized for an Elsevier double-column page:
  fig_breakdown.pdf   mean composition of the store latency: 2SDIF vs baselines B0-B2 (local chain)
  fig_ecdf.pdf        distribution (ECDF) of the end-to-end store latency, same four designs
  fig_load.pdf        witness bursts, witness fixed-rate load, end-to-end throughput vs devices
  fig_sepolia.pdf     Sepolia commit latency against the send time's phase in the 12 s slot
  fig_audit.pdf       detection delay of injected faults against the auditor's bound
A figure whose inputs are missing is skipped with a message.
"""
import argparse
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

# Categorical slots (validated: adjacent CVD dE >= 9.1, normal-vision dE >= 19.6 on a light surface).
# Slots 3-5 are below 3:1 contrast, so every series is also named by a direct label or legend.
C = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"]
INK, INK2, GRID = "#0b0b0b", "#52514e", "#e4e3df"
COL1, COL2 = 3.46, 7.16  # inches: single and double column width (cas-dc)

plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Liberation Sans", "Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 7.5,
    "axes.labelsize": 7.5,
    "axes.titlesize": 7.5,
    "xtick.labelsize": 7,
    "ytick.labelsize": 7,
    "legend.fontsize": 7,
    "axes.edgecolor": INK2,
    "axes.labelcolor": INK,
    "xtick.color": INK2,
    "ytick.color": INK2,
    "axes.linewidth": 0.6,
    "xtick.major.width": 0.6,
    "ytick.major.width": 0.6,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.color": GRID,
    "grid.linewidth": 0.5,
    "axes.axisbelow": True,
    "legend.frameon": False,
    "pdf.fonttype": 42,
    "savefig.bbox": "tight",
    "savefig.pad_inches": 0.02,
})


def read(path):
    return pd.read_csv(path) if os.path.exists(path) else None


def save(fig, out, name):
    fig.savefig(os.path.join(out, name))
    plt.close(fig)
    print(f"[figures] wrote {name}")


def breakdown(res, out):
    rows = []
    s = read(os.path.join(res, "latency_azure.csv"))
    if s is None:
        return print("[figures] skip breakdown: latency_azure.csv missing")
    rows.append(("2SDIF", s))
    for m in ["B0", "B1", "B2"]:
        b = read(os.path.join(res, f"latency_{m}.csv"))
        if b is not None:
            rows.append((m, b))
    labels = {"2SDIF": "2SDIF (witness on Azure)", "B0": "B0 trusted gateway", "B1": "B1 device secp256k1", "B2": "B2 device P-256"}
    parts = [("depositMs", "Witness deposit"), ("transferMs", "Device to gateway"), ("fetchMs", "Attestation fetch"),
             ("verifyMs", "Gateway checks"), ("commitMs", "On-chain commit"), ("persistMs", "Persist")]
    fig, ax = plt.subplots(figsize=(COL2, 0.42 + 0.27 * len(rows)))
    y = np.arange(len(rows))[::-1]
    for (name, df), yy in zip(rows, y):
        left = 0.0
        for k, (col, _) in enumerate(parts):
            v = float(df[col].mean()) if col in df else 0.0
            if v > 0:
                ax.barh(yy, v, left=left, height=0.56, color=C[k], edgecolor="white", linewidth=1.0)
            left += v
        ax.text(left + 2, yy, f"{left:.0f} ms", va="center", ha="left", color=INK, fontsize=7)
    ax.set_yticks(y, [labels[n] for n, _ in rows])
    ax.tick_params(axis="y", length=0)
    ax.grid(axis="y", visible=False)
    ax.set_xlabel("Mean latency of a stored reading (ms)")
    ax.set_xlim(0, ax.get_xlim()[1] * 1.08)
    handles = [plt.Rectangle((0, 0), 1, 1, color=C[k]) for k in range(len(parts))]
    ax.legend(handles, [p[1] for p in parts], ncol=6, loc="lower left", bbox_to_anchor=(0, 1.0), handlelength=1.0, columnspacing=1.2)
    save(fig, out, "fig_breakdown.pdf")


def ecdf(res, out):
    series = [("2SDIF", "latency_azure.csv"), ("B0", "latency_B0.csv"), ("B1", "latency_B1.csv"), ("B2", "latency_B2.csv")]
    data = [(n, read(os.path.join(res, f))) for n, f in series]
    data = [(n, d) for n, d in data if d is not None]
    if not data:
        return print("[figures] skip ecdf: no latency files")
    fig, ax = plt.subplots(figsize=(COL1, 2.2))
    for k, (name, df) in enumerate(data):
        v = np.sort(df["e2eMs"].astype(float).values)
        p = np.arange(1, len(v) + 1) / len(v)
        ax.step(v, p, where="post", color=C[k], linewidth=1.3, label=name)
        med = float(np.median(v))
        ax.annotate(name, (med, 0.5), xytext=(4, -2), textcoords="offset points", color=INK, fontsize=7, ha="left", va="top")
    ax.set_xlabel("End-to-end store latency (ms)")
    ax.set_ylabel("Fraction of readings")
    ax.set_ylim(0, 1.02)
    ax.legend(loc="lower right", handlelength=1.4)
    save(fig, out, "fig_ecdf.pdf")


def quant(v, q):
    return float(np.percentile(np.asarray(v, dtype=float), q))


def load(res, out):
    burst = read(os.path.join(res, "load_witness_burst.csv"))
    rate = read(os.path.join(res, "load_witness_rate.csv"))
    e2e = read(os.path.join(res, "load_e2e.csv"))
    summ = read(os.path.join(res, "load_e2e_summary.csv"))
    if burst is None and rate is None and summ is None:
        return print("[figures] skip load: no load files")
    fig, axes = plt.subplots(1, 3, figsize=(COL2, 2.0))
    ax = axes[0]
    if burst is not None:
        ok = burst[burst.status == 201]
        lv = sorted(ok.level.unique())
        med = [quant(ok[ok.level == l].latencyMs, 50) for l in lv]
        p95 = [quant(ok[ok.level == l].latencyMs, 95) for l in lv]
        ax.plot(lv, med, "-o", color=C[0], linewidth=1.3, markersize=3.5, markeredgecolor="white", markeredgewidth=0.6, label="median")
        ax.plot(lv, p95, "-o", color=C[1], linewidth=1.3, markersize=3.5, markeredgecolor="white", markeredgewidth=0.6, label="95th pct.")
        for l, m in zip(lv, p95):
            n = burst[burst.level == l].instance.nunique()
            ax.annotate(f"{n} inst.", (l, m), xytext=(0, 4), textcoords="offset points", ha="center", fontsize=6, color=INK2)
        fails = int((burst.status != 201).sum())
        ax.set_title(f"(a) Witness, k deposits at once" + (f"  ({fails} failed)" if fails else ""), loc="left")
        ax.set_xlabel("Concurrent deposits k")
        ax.set_ylabel("Deposit latency (ms)")
        ax.legend(loc="upper left", handlelength=1.4)
        ax.set_ylim(0, max(p95) * 1.25)
    ax = axes[1]
    if rate is not None:
        ok = rate[rate.status == 201]
        rv = sorted(ok.rate.unique())
        ax.plot(rv, [quant(ok[ok.rate == r].latencyMs, 50) for r in rv], "-o", color=C[0], linewidth=1.3, markersize=3.5, markeredgecolor="white", markeredgewidth=0.6, label="median")
        p95 = [quant(ok[ok.rate == r].latencyMs, 95) for r in rv]
        ax.plot(rv, p95, "-o", color=C[1], linewidth=1.3, markersize=3.5, markeredgecolor="white", markeredgewidth=0.6, label="95th pct.")
        for r, m in zip(rv, p95):
            n = rate[rate.rate == r].instance.nunique()
            ax.annotate(f"{n} inst.", (r, m), xytext=(0, 4), textcoords="offset points", ha="center", fontsize=6, color=INK2)
        fails = int((rate.status != 201).sum())
        ax.set_title("(b) Witness, fixed arrival rate" + (f"  ({fails} failed)" if fails else ""), loc="left")
        ax.set_xlabel("Offered load (deposits/s)")
        ax.set_ylabel("Deposit latency (ms)")
        ax.set_ylim(0, max(p95) * 1.25)
    ax = axes[2]
    if summ is not None:
        ax.plot(summ.devices, summ.throughputPerSec, "-o", color=C[0], linewidth=1.3, markersize=3.5, markeredgecolor="white", markeredgewidth=0.6)
        if e2e is not None:
            okr = e2e[e2e.ok == 1]
            for d, t in zip(summ.devices, summ.throughputPerSec):
                m = quant(okr[okr.devices == d].e2eMs, 50) if len(okr[okr.devices == d]) else float("nan")
                ax.annotate(f"{m:.0f} ms", (d, t), xytext=(0, 5), textcoords="offset points", ha="center", fontsize=6, color=INK2)
        ax.set_title("(c) Store path, k devices", loc="left")
        ax.set_xlabel("Concurrent devices k")
        ax.set_ylabel("Committed readings/s")
        ax.set_ylim(bottom=0, top=float(summ.throughputPerSec.max()) * 1.25)
    fig.tight_layout(w_pad=1.2)
    save(fig, out, "fig_load.pdf")


def sepolia(res, out):
    b = read(os.path.join(res, "sepolia_blocks.csv"))
    if b is None:
        return print("[figures] skip sepolia: sepolia_blocks.csv missing")
    fig, ax = plt.subplots(figsize=(COL1, 2.2))
    waited = b.slotsWaited.astype(int)
    for k, w in enumerate(sorted(waited.unique())):
        sel = b[waited == w]
        ax.scatter(sel.slotPhaseSec, sel.commitSec, s=12, color=C[k % 3], edgecolor="white", linewidth=0.5, label=f"included {w} slot{'s' if w != 1 else ''} later", zorder=3)
    ph = np.linspace(0, 12, 50)
    ax.plot(ph, 12 - ph, color=INK2, linewidth=0.8, linestyle=(0, (3, 2)), zorder=2, label="time to the next slot")
    ax.set_xlim(0, 12)
    ax.set_xlabel("Send time within the 12 s slot (s)")
    ax.set_ylabel("Commit latency (s)")
    ax.set_ylim(bottom=0)
    ax.legend(loc="upper right", handletextpad=0.2)
    save(fig, out, "fig_sepolia.pdf")


def audit(res, out):
    s = os.path.join(res, "audit_summary.json")
    t = read(os.path.join(res, "audit_truth.csv"))
    w = read(os.path.join(res, "audit_watch.csv"))
    if not os.path.exists(s) or t is None or w is None:
        return print("[figures] skip audit: audit files missing")
    summ = json.load(open(s))
    par = summ["parameters"]
    first = w.groupby(["rid", "kind"]).auditTime.min().reset_index()
    t["rid"] = t["rid"].str.lower()
    first["rid"] = first["rid"].str.lower()
    cls = []
    for outcome, kind, label in [("withheld", "OMITTED", "withheld\nflagged OMITTED"), ("delayed", "OMITTED", "delayed\nfirst flagged OMITTED"), ("delayed", "LATE", "delayed\nthen flagged LATE")]:
        m = t[t.outcome == outcome].merge(first[first.kind == kind], on="rid")
        cls.append((label, (m.auditTime - m.tW.astype(float)).values))
    gaps = w[w.kind == "GAP"]
    sup = t[t.outcome == "suppressed"]
    gd = []
    for _, r in sup.iterrows():
        seq = int(r.seq)
        for _, g in gaps.iterrows():
            lo, hi = [int(x) for x in g.rid.split(":")[1].split("-")]
            if lo <= seq <= hi:
                gd.append(g.auditTime - r.sentAt / 1000)
                break
    cls.append(("suppressed\nflagged GAP", np.array(gd)))
    fig, ax = plt.subplots(figsize=(COL1, 2.0))
    rng = np.random.default_rng(1)
    for k, (label, v) in enumerate(cls):
        yy = len(cls) - 1 - k + rng.uniform(-0.12, 0.12, len(v))
        ax.scatter(v, yy, s=12, color=C[k], edgecolor="white", linewidth=0.5, zorder=3)
    b1 = par["deltaSec"] + par["skewSec"]
    ax.axvline(b1, color=INK2, linewidth=0.8, linestyle=(0, (3, 2)))
    ax.annotate(r"$\Delta+\epsilon$", (b1, len(cls) - 0.45), xytext=(3, 0), textcoords="offset points", fontsize=6.5, color=INK2)
    ax.axvline(b1 + par["periodSec"], color=INK2, linewidth=0.8, linestyle=(0, (1, 1.5)))
    ax.annotate(r"$\Delta+\epsilon+T$", (b1 + par["periodSec"], len(cls) - 0.45), xytext=(3, 0), textcoords="offset points", fontsize=6.5, color=INK2)
    ax.set_yticks(range(len(cls)), [c[0] for c in cls][::-1])
    ax.tick_params(axis="y", length=0)
    ax.grid(axis="y", visible=False)
    ax.set_ylim(-0.6, len(cls) - 0.2)
    ax.set_xlabel("Time from witness attestation to first flag (s)")
    ax.set_xlim(left=0)
    save(fig, out, "fig_audit.pdf")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default="results")
    ap.add_argument("--out", default="figs")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    for f in (breakdown, ecdf, load, sepolia, audit):
        try:
            f(a.results, a.out)
        except Exception as e:  # keep going: one broken input should not stop the others
            print(f"[figures] {f.__name__} failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
