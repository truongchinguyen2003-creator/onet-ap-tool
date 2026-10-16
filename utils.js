"use strict";

// ════════════════════════════════════════════════════════════════════
// utils.js — Shared utilities
// ════════════════════════════════════════════════════════════════════

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min, max) {
  return delay(min + Math.floor(Math.random() * (max - min)));
}

function generateRandomPassword(length = 16) {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const all = upper + lower + digits; // không có # ở đây

  // Guarantee at least 1 of each type
  let pw = "";
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += "#"; // đúng 1 dấu #

  for (let i = pw.length; i < length; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

const log = {
  info: (...args) => console.log(`  ℹ️ `, ...args),
  ok: (...args) => console.log(`  ✅`, ...args),
  warn: (...args) => console.log(`  ⚠️ `, ...args),
  err: (...args) => console.log(`  ❌`, ...args),
  proxy: (...args) => console.log(`  🔀`, ...args),
  divider: (text) => {
    console.log(`\n${"═".repeat(20)} ${text} ${"═".repeat(20)}`);
  },
};

module.exports = { delay, randomDelay, generateRandomPassword, log };
