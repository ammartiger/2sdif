"use strict";
/** Write-once attestation store on Azure Table Storage. createEntity fails with 409 if the row exists.
 *  Rows are spread over 256 partitions by the first byte of the record id, so writes are not confined to a
 *  single partition, while a lookup by record id still addresses exactly one row. */
const { TableClient } = require("@azure/data-tables");

const partitionOf = (rid) => String(rid).slice(2, 4);

class TableStore {
  constructor(connectionString, tableName = "attestations") {
    // Plain HTTP is only allowed for the local Azurite emulator (development and tests).
    const local = /UseDevelopmentStorage=true|127\.0\.0\.1|localhost/i.test(connectionString || "");
    this.client = TableClient.fromConnectionString(connectionString, tableName, local ? { allowInsecureConnection: true } : {});
    this.ready = this.client.createTable().catch((e) => {
      if (e.statusCode !== 409) throw e;
    });
  }
  async insertOnce(entity) {
    await this.ready;
    try {
      await this.client.createEntity({ partitionKey: partitionOf(entity.rid), rowKey: entity.rid, ...entity });
      return true;
    } catch (e) {
      if (e.statusCode === 409) return false;
      throw e;
    }
  }
  async get(rid) {
    await this.ready;
    try {
      const e = await this.client.getEntity(partitionOf(rid), rid);
      return { rid: e.rid, did: e.did, seq: String(e.seq), h: e.h, tW: Number(e.tW), sig: e.sig, dep: e.dep };
    } catch (e) {
      if (e.statusCode === 404) return null;
      throw e;
    }
  }
  async list(sinceSec) {
    await this.ready;
    const out = [];
    const filter = `tW ge ${Number(sinceSec) || 0}`;
    for await (const e of this.client.listEntities({ queryOptions: { filter } })) {
      out.push({ rid: e.rid, did: e.did, seq: String(e.seq), h: e.h, tW: Number(e.tW), sig: e.sig, dep: e.dep });
    }
    return out;
  }
}

module.exports = { TableStore };
