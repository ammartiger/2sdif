"use strict";
/**
 * Local record store at the fog gateway: one JSON file per collection, rewritten atomically.
 * Writes to the same collection are serialized, so concurrent requests cannot race on the file.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

class JsonStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.cache = new Map();
    this.queues = new Map(); // collection -> tail of the write chain
  }
  _file(col) {
    return path.join(this.dir, `${col}.json`);
  }
  _load(col) {
    if (!this.cache.has(col)) {
      let data = {};
      try {
        data = JSON.parse(fs.readFileSync(this._file(col), "utf8"));
      } catch {}
      this.cache.set(col, data);
    }
    return this.cache.get(col);
  }
  get(col, id) {
    return this._load(col)[id] || null;
  }
  put(col, id, value) {
    const data = this._load(col);
    data[id] = value;
    const write = async () => {
      const tmp = `${this._file(col)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(data));
      // On Windows a scanner or indexer can hold the target briefly (EPERM/EBUSY/EACCES): retry the rename
      for (let i = 0; ; i++) {
        try {
          await fs.promises.rename(tmp, this._file(col));
          break;
        } catch (e) {
          if (i >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
          await new Promise((ok) => setTimeout(ok, 10 * (i + 1)));
        }
      }
    };
    const tail = (this.queues.get(col) || Promise.resolve()).then(write);
    this.queues.set(col, tail.catch(() => {}));
    return tail;
  }
}

module.exports = { JsonStore };
