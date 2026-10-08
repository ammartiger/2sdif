"use strict";
/**
 * Merkle tree for batched commitments, identical to TwoSDIFRegistry.commitBatch / verifyBatched:
 * leaf = keccak256(abi.encode(0x00, rid, digest)), node = keccak256(abi.encode(0x01, left, right)),
 * pairs hashed left to right, an unpaired last node carried up unchanged.
 */
const { ethers } = require("ethers");

const abi = ethers.AbiCoder.defaultAbiCoder();
const leaf = (rid, digest) => ethers.keccak256(abi.encode(["bytes1", "bytes32", "bytes32"], ["0x00", rid, digest]));
const node = (l, r) => ethers.keccak256(abi.encode(["bytes1", "bytes32", "bytes32"], ["0x01", l, r]));

function levels(leaves) {
  const out = [leaves.slice()];
  let cur = leaves.slice();
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i + 1 < cur.length; i += 2) next.push(node(cur[i], cur[i + 1]));
    if (cur.length % 2 === 1) next.push(cur[cur.length - 1]);
    out.push(next);
    cur = next;
  }
  return out;
}

function root(leaves) {
  const ls = levels(leaves);
  return ls[ls.length - 1][0];
}

function proof(leaves, index) {
  const path = [];
  let i = index;
  for (const lv of levels(leaves).slice(0, -1)) {
    if (i % 2 === 1) path.push(lv[i - 1]);
    else if (i + 1 < lv.length) path.push(lv[i + 1]);
    i = Math.floor(i / 2);
  }
  return path;
}

module.exports = { leaf, node, root, proof };
