"use strict";

const config = require("./config/config4");
const { run } = require("./runner");
const { log } = require("./utils");

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg === "--headless") config.BROWSER.HEADLESS = true;
  if (arg.startsWith("--proxy-onet=")) { config.PROXY_ONET.enabled = true; config.PROXY_ONET.address = arg.split("=")[1]; }
  if (arg.startsWith("--proxy-apple=")) { config.PROXY_APPLE.enabled = true; config.PROXY_APPLE.address = arg.split("=")[1]; }
  if (arg.startsWith("--proxy=") && !arg.startsWith("--proxy-")) {
    const addr = arg.split("=")[1];
    config.PROXY_ONET.enabled = true; config.PROXY_ONET.address = addr;
    config.PROXY_APPLE.enabled = true; config.PROXY_APPLE.address = addr;
  }
  if (arg.startsWith("--capsolver=")) { config.CAPSOLVER.enabled = true; config.CAPSOLVER.apiKey = arg.split("=")[1]; }
}

log.divider("APPLE-ONET-TOOL [Instance 4]");
log.info("Data folder: data/4/");
log.info("Proxy Onet: " + (config.PROXY_ONET.enabled ? config.PROXY_ONET.address.split(":").slice(0, 2).join(":") : "OFF"));
log.info("Proxy Apple: " + (config.PROXY_APPLE.enabled ? config.PROXY_APPLE.address.split(":").slice(0, 2).join(":") : "OFF"));
log.info("CapSolver: " + (config.CAPSOLVER.enabled ? "ON" : "OFF"));
log.info("Headless: " + config.BROWSER.HEADLESS);

run(config).catch((e) => {
  log.err("Fatal: " + e.message);
  console.error(e);
  process.exit(1);
});
