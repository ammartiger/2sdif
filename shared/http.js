"use strict";
/**
 * HTTP client settings shared by the device simulator, gateway and scripts.
 *   KEEPALIVE_MS   idle time before a pooled HTTPS connection is closed (default 60000);
 *                  "0" disables connection reuse entirely (one connection per request).
 * connectionCount() counts new TCP/TLS connections opened by this process (diagnostics channel),
 * so that experiments can report whether a request paid for connection setup.
 */
const dc = require("diagnostics_channel");

let connects = 0;
dc.subscribe("undici:client:connected", () => {
  connects += 1;
});

function connectionCount() {
  return connects;
}

let configured = false;
function configureHttp() {
  if (configured) return;
  configured = true;
  let undici;
  try {
    undici = require("undici");
  } catch {
    return;
  }
  const ka = process.env.KEEPALIVE_MS;
  const opts = ka === "0" ? { pipelining: 0 } : { keepAliveTimeout: Number(ka || 60000), keepAliveMaxTimeout: Math.max(Number(ka || 60000), 600000) };
  undici.setGlobalDispatcher(new undici.Agent(opts));
}

module.exports = { configureHttp, connectionCount };
