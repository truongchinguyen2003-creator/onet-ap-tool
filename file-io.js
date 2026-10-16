"use strict";

// ════════════════════════════════════════════════════════════════════
// file-io.js — File I/O for apple-onet-tool
// Input main: mail|password (onet.pl accounts)
// Input working: 1 email per line (apple IDs to reset)
// Success: appleid|newPassword
// Failed: appleid|reason
// ════════════════════════════════════════════════════════════════════

const fs = require("fs").promises;
const { log } = require("./utils");

function createFileIO(config) {
  // ── Read main accounts: mail|password (1 per line) ──
  async function readMainAccounts() {
    const content = await fs.readFile(config.PATHS.MAIN_ACCOUNTS, "utf-8");
    const lines = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("|"));

    const accounts = lines
      .map((l) => {
        const [email = "", password = ""] = l.split("|");
        return { email: email.trim(), password: password.trim(), raw: l };
      })
      .filter((a) => a.email && a.password);

    log.info(`Loaded ${accounts.length} main account(s)`);
    return accounts;
  }

  // ── Read working emails pool: 1 email per line ──
  async function readWorkingEmails() {
    const content = await fs.readFile(config.PATHS.WORKING_EMAILS, "utf-8");
    const emails = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    log.info(`Loaded ${emails.length} working email(s)`);
    return emails;
  }

  // ── Remove processed email from working pool ──
  // Không catch — để lỗi ENOSPC propagate lên safeFileOp
  async function removeFromPool(email) {
    const content = await fs.readFile(config.PATHS.WORKING_EMAILS, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((l) => l.trim() !== email.trim());
    await fs.writeFile(
      config.PATHS.WORKING_EMAILS,
      filtered.join("\n"),
      "utf-8",
    );
  }

  // ── Write success: appleid|newPassword ──
  async function writeSuccess(appleid, newPassword) {
    const line = `${appleid}|${newPassword}\n`;
    await fs.appendFile(config.PATHS.OUTPUT_SUCCESS, line, "utf-8");
    log.ok(`Saved success: ${appleid}`);
  }

  // ── Write failed: appleid|reason ──
  async function writeFailed(appleid, reason) {
    const cleanReason = (reason || "")
      .replace(/\r?\n/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const line = `${appleid}|${cleanReason}\n`;
    await fs.appendFile(config.PATHS.OUTPUT_FAILED, line, "utf-8");
    log.err(`Failed: ${appleid} - ${cleanReason}`);
  }

  // ── Move main account to done ──
  // Không catch — để lỗi ENOSPC propagate lên safeFileOp
  async function markMainDone(rawLine) {
    await fs.appendFile(
      config.PATHS.MAIN_ACCOUNTS_DONE,
      rawLine + "\n",
      "utf-8",
    );
    await removeFromMainAccounts(rawLine);
  }

  // ── Chỉ xóa khỏi main-accounts (không ghi vào done) ──
  // Dùng cho invalid password — đã ghi vào main_account_invalid.txt rồi
  async function removeFromMainAccounts(rawLine) {
    const content = await fs.readFile(config.PATHS.MAIN_ACCOUNTS, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((l) => l.trim() !== rawLine.trim());
    await fs.writeFile(
      config.PATHS.MAIN_ACCOUNTS,
      filtered.join("\n"),
      "utf-8",
    );
  }

  // ── Read pending emails (alias added but not yet completed) ──
  async function readPending() {
    try {
      const content = await fs.readFile(config.PATHS.PENDING, "utf-8");
      const emails = content
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      return emails;
    } catch {
      return [];
    }
  }

  // ── Write email to pending (after alias added, before flow completes) ──
  async function writePending(email) {
    await fs.appendFile(config.PATHS.PENDING, email.trim() + "\n", "utf-8");
    log.info(`Pending: ${email}`);
  }

  // ── Remove email from pending (after success or fail) ──
  // Không catch — để lỗi ENOSPC propagate lên safeFileOp
  async function removeFromPending(email) {
    const content = await fs.readFile(config.PATHS.PENDING, "utf-8");
    const lines = content.split("\n");
    const filtered = lines.filter((l) => l.trim() !== email.trim());
    await fs.writeFile(config.PATHS.PENDING, filtered.join("\n"), "utf-8");
  }

  // ── Write main account to invalid file (wrong password) ──
  async function writeMainInvalid(rawLine) {
    const invalidPath = config.PATHS.MAIN_ACCOUNTS.replace(
      /main-accounts\d*\.txt$/,
      "main_account_invalid.txt",
    );
    await fs.appendFile(invalidPath, rawLine.trim() + "\n", "utf-8");
    log.err(`Invalid password — saved to main_account_invalid.txt`);
  }

  return {
    readMainAccounts,
    readWorkingEmails,
    removeFromPool,
    writeSuccess,
    writeFailed,
    markMainDone,
    removeFromMainAccounts,
    writeMainInvalid,
    readPending,
    writePending,
    removeFromPending,
  };
}

module.exports = { createFileIO };
