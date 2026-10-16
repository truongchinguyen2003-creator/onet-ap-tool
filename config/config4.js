"use strict";

const path = require("path");
const BASE_DIR = path.join(__dirname, "..");

const config = {
  INSTANCE: 4,

  PATHS: {
    MAIN_ACCOUNTS: path.join(BASE_DIR, "data", "4", "main-accounts4.txt"),
    MAIN_ACCOUNTS_DONE: path.join(
      BASE_DIR,
      "data",
      "4",
      "main-accounts-done4.txt",
    ),
    WORKING_EMAILS: path.join(BASE_DIR, "data", "4", "working-emails4.txt"),
    OUTPUT_SUCCESS: path.join(BASE_DIR, "data", "4", "output-success4.txt"),
    OUTPUT_FAILED: path.join(BASE_DIR, "data", "4", "output-failed4.txt"),
    PENDING: path.join(BASE_DIR, "data", "4", "pending4.txt"),
  },

  BROWSER: {
    HEADLESS: false,
    WINDOW_SIZE: "600,700",
    ONET_WINDOW: { size: "680,700", position: "1280,700" },
    APPLE_WINDOW: { size: "600,700", position: "1960,700" },
  },

  PROXY_ONET: {
    enabled: true,
    address: "43.230.9.47:1000:baodinh1tketamin-region-PL:baodinh1tmdma",
  },
  PROXY_APPLE: {
    enabled: true,
    address: "43.230.9.47:1000:baodinh1tketamin-region-PL:baodinh1tmdma",
  },

  CAPSOLVER: {
    enabled: true,
    apiKey:
      "CAP-1FF7B8AA38122C12E4A08F49F9586DDEF3CBF6D4CEB757E308F376891C8154B2",
  },

  TWO_CAPTCHA: {
    enabled: true,
    apiKey: "70c2feeaabdfc45f038aba48c7568392",
  },

  TIMING: {
    DELAY_BETWEEN_ALIASES: 3000,
    DELAY_BETWEEN_BATCHES: 5000,
    DELAY_BETWEEN_MAIN_ACCOUNTS: 10000,
    EMAIL_WAIT_RETRY_DELAY: 5000,
    EMAIL_WAIT_MAX_RETRIES: 3,
  },
};

module.exports = config;
