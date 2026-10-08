"use strict";
/**
 * Post-processing for the Sepolia store benchmark: for every committed reading, fetch the inclusion block
 * and relate the gateway's send time to Ethereum's 12 s slot grid.
 *   node scripts/sepolia-blocks.js [--in results/latency_sepolia.csv] [--out results/sepolia_blocks.csv]
 * Env: SEPOLIA_RPC_URL.
 * Columns: slotPhaseSec  = seconds between the start of the slot in which the transaction was sent and the
 *                          send time (0..12); slot starts are block timestamps, which on Ethereum are
 *                          genesis + 12 k
 *          slotsWaited   = (inclusion block timestamp - start of the send slot) / 12
 *          inclusionSec  = inclusion block timestamp - send time
 *          receiptLagSec = time the gateway obtained the receipt - inclusion block timestamp
 *                          (block propagation + RPC polling interval)
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cfg = require("../shared/config");

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SLOT = 12;

async function main() {
  const inFile = arg("in", path.join(cfg.ROOT, "results", "latency_sepolia.csv"));
  const out = arg("out", path.join(cfg.ROOT, "results", "sepolia_blocks.csv"));
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL || cfg.rpcUrl("sepolia"));
  const [head, ...lines] = fs.readFileSync(inFile, "utf8").trim().split(/\r?\n/);
  const cols = head.split(",");
  const rows = lines.map((l) => Object.fromEntries(cols.map((c, i) => [c, l.split(",")[i]])));
  // a reference slot boundary: any block timestamp (slots are aligned to genesis + 12 k)
  const ref = (await provider.getBlock("latest")).timestamp;
  const blockCache = new Map();
  const outRows = [];
  for (const r of rows) {
    if (!r.txHash) continue;
    let bn = r.blockNumber ? Number(r.blockNumber) : null;
    if (bn === null) bn = (await provider.getTransactionReceipt(r.txHash)).blockNumber;
    if (!blockCache.has(bn)) blockCache.set(bn, await provider.getBlock(bn));
    const b = blockCache.get(bn);
    const sent = Number(r.commitSentAt) / 1000;
    const slotStart = ref - Math.ceil((ref - sent) / SLOT) * SLOT; // largest slot start <= sent
    const phase = sent - slotStart;
    const commitSec = Number(r.commitMs) / 1000;
    const receiptSeen = Number(r.commitDoneAt) / 1000; // gateway obtained the receipt
    outRows.push({
      trial: r.trial,
      txHash: r.txHash,
      blockNumber: bn,
      blockTime: b.timestamp,
      sentAt: sent.toFixed(3),
      slotPhaseSec: phase.toFixed(3),
      slotsWaited: ((b.timestamp - slotStart) / SLOT).toFixed(0),
      inclusionSec: (b.timestamp - sent).toFixed(3),
      receiptLagSec: (receiptSeen - b.timestamp).toFixed(3),
      commitSec: commitSec.toFixed(3),
      gasUsed: r.gasUsed,
      txCountInBlock: b.transactions.length,
      gasUsedInBlock: b.gasUsed.toString(),
    });
  }
  fs.writeFileSync(out, [Object.keys(outRows[0]).join(","), ...outRows.map((o) => Object.values(o).join(","))].join("\n") + "\n");
  const waited = outRows.map((o) => Number(o.slotsWaited));
  const hist = {};
  for (const w of waited) hist[w] = (hist[w] || 0) + 1;
  console.log(`[sepolia-blocks] ${outRows.length} commitments; slots waited: ${JSON.stringify(hist)}; wrote ${out}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
