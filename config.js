"use strict";

// ════════════════════════════════════════════════════════════════════
// config.js — Configuration for apple-onet-tool
// ════════════════════════════════════════════════════════════════════

const path = require("path");
const BASE_DIR = __dirname;

const config = {
  // ── Paths ──
  PATHS: {
    MAIN_ACCOUNTS: path.join(BASE_DIR, "data", "main-accounts.txt"),
    MAIN_ACCOUNTS_DONE: path.join(BASE_DIR, "data", "main-accounts-done.txt"),
    WORKING_EMAILS: path.join(BASE_DIR, "data", "working-emails.txt"),
    OUTPUT_SUCCESS: path.join(BASE_DIR, "data", "output-success.txt"),
    OUTPUT_FAILED: path.join(BASE_DIR, "data", "output-failed.txt"),
    PENDING: path.join(BASE_DIR, "data", "pending.txt"),
  },

  // ── Browser ──
  BROWSER: {
    HEADLESS: false,
    WINDOW_SIZE: "640,720",
    ONET_WINDOW: { size: "900,800", position: "0,0" },
    APPLE_WINDOW: { size: "640,720", position: "920,0" },
  },

  PROXY_ONET: {
    enabled: false,
    address: "43.230.9.47:1000:xvasnthien01-region-PL:bbshygegxc",
  },
  PROXY_APPLE: {
    enabled: true,
    address: "rp.scrapegw.com:6060:ebfv0pt462nv0ts:k46s12a1wjuuzb0",
  },

  // ── CapSolver ──
  CAPSOLVER: {
    enabled: true,
    apiKey:
      "CAP-1FF7B8AA38122C12E4A08F49F9586DDEF3CBF6D4CEB757E308F376891C8154B2",
  },

  // ── Timing ──
  TIMING: {
    DELAY_BETWEEN_ALIASES: 3000,
    DELAY_BETWEEN_BATCHES: 5000,
    DELAY_BETWEEN_MAIN_ACCOUNTS: 10000,
    EMAIL_WAIT_RETRY_DELAY: 5000,
    EMAIL_WAIT_MAX_RETRIES: 5,
  },
};

module.exports = config;
