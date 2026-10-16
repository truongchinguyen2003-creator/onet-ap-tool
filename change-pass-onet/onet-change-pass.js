"use strict";

// ════════════════════════════════════════════════════════════════════
// onet-change-pass.js — Đổi password Onet.pl hàng loạt
//
// Input:  data/change-pass-input.txt   (mail|currentpass)
// Output: data/change-pass-done.txt    (mail|newpass)
// Failed: data/change-pass-failed.txt  (mail|currentpass|reason)
// ════════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

// ── Config ──
const DATA_DIR = path.join(__dirname, "data");
const INPUT_FILE = path.join(DATA_DIR, "change-pass-input.txt");
const DONE_FILE = path.join(DATA_DIR, "change-pass-done.txt");
const FAILED_FILE = path.join(DATA_DIR, "change-pass-failed.txt");

const HEADLESS = false;
const WINDOW_SIZE = "640,720";
const WINDOW_POSITION = "0,0";

// Proxy: set null để tắt, hoặc "host:port:user:pass"
const PROXY = null;

// Số luồng chạy song song (mỗi luồng = 1 browser)
const THREADS = 1;

const BLOCKED_DOMAINS = ["html-load.com", "error-report.com"];

const URLS = {
  LOGIN:
    "https://konto.onet.pl/en/signin?state=https%3A%2F%2Fpoczta.onet.pl%2F&client_id=poczta.onet.pl.front.onetapi.pl",
  MAILBOX: "https://poczta.onet.pl/",
  CHANGE_PASS:
    "https://konto.onet.pl/change-password?client_id=konto.onet.pl.front.onetapi.pl",
};

// ── Utils ──
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const log = {
  info: (msg) => console.log(`  \x1b[36mℹ️\x1b[0m  ${msg}`),
  ok: (msg) => console.log(`  \x1b[32m✅\x1b[0m ${msg}`),
  warn: (msg) => console.log(`  \x1b[33m⚠️\x1b[0m  ${msg}`),
  err: (msg) => console.log(`  \x1b[31m❌\x1b[0m ${msg}`),
  divider: (msg) =>
    console.log(
      `\n\x1b[90m${"═".repeat(20)}\x1b[0m ${msg} \x1b[90m${"═".repeat(20)}\x1b[0m`,
    ),
};

function generateRandomPassword(length = 16) {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const special = "#";
  const all = upper + lower + digits + special;

  // Đảm bảo có ít nhất 1 ký tự mỗi loại
  let pw = "";
  pw += upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  pw += special[Math.floor(Math.random() * special.length)];

  for (let i = pw.length; i < length; i++) {
    pw += all[Math.floor(Math.random() * all.length)];
  }

  // Shuffle
  return pw
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

// ── Thread-safe File IO ──
let fileLock = Promise.resolve();
function withLock(fn) {
  fileLock = fileLock.then(fn, fn);
  return fileLock;
}

function readInput() {
  if (!fs.existsSync(INPUT_FILE)) {
    log.err(`Input file not found: ${INPUT_FILE}`);
    return [];
  }
  const lines = fs
    .readFileSync(INPUT_FILE, "utf-8")
    .split("\n")
    .filter(Boolean);
  return lines.map((line) => {
    const [email, password] = line.trim().split("|");
    return { email, password, raw: line.trim() };
  });
}

function appendDone(email, newPassword, oldPassword) {
  return withLock(() => {
    fs.appendFileSync(DONE_FILE, `${email}|${newPassword}|${oldPassword}\n`);
  });
}

function appendFailed(email, currentPassword, reason) {
  return withLock(() => {
    fs.appendFileSync(FAILED_FILE, `${email}|${currentPassword}|${reason}\n`);
  });
}

function removeFromInput(rawLine) {
  return withLock(() => {
    if (!fs.existsSync(INPUT_FILE)) return;
    const lines = fs
      .readFileSync(INPUT_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim() && l.trim() !== rawLine);
    fs.writeFileSync(INPUT_FILE, lines.join("\n") + (lines.length ? "\n" : ""));
  });
}

// ── Safe navigation with retry ──
async function safeGoto(page, url, opts = {}, maxRetries = 3) {
  const navOpts = { waitUntil: "networkidle2", timeout: 30000, ...opts };
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, navOpts);
    } catch (e) {
      if (attempt < maxRetries) {
        log.warn(
          `Nav error (attempt ${attempt}/${maxRetries}): ${e.message.slice(0, 60)} — retrying...`,
        );
        await delay(3000);
        continue;
      }
      throw e;
    }
    const cur = page.url();
    if (cur.includes("chrome-error://") || cur.includes("error-report.com")) {
      if (attempt < maxRetries) {
        log.warn(
          `Bad redirect (attempt ${attempt}/${maxRetries}) — retrying...`,
        );
        await delay(2000);
        continue;
      }
      throw new Error(`Bad redirect after ${maxRetries} attempts: ${url}`);
    }
    return;
  }
}

// ── Launch browser ──
async function launchBrowser(extraArgs = []) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    "--disable-save-password-bubble",
    "--disable-features=PasswordManager",
    "--password-store=basic",
    "--host-resolver-rules=MAP html-load.com 0.0.0.0, MAP error-report.com 0.0.0.0, MAP *.html-load.com 0.0.0.0, MAP *.error-report.com 0.0.0.0",
    `--window-size=${WINDOW_SIZE}`,
    `--window-position=${WINDOW_POSITION}`,
    ...extraArgs,
  ];

  if (PROXY) {
    const parts = PROXY.split(":");
    args.push(`--proxy-server=http://${parts[0]}:${parts[1]}`);
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args,
    defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Setup protection on all pages
  const setupPage = async (p) => {
    p.on("dialog", async (dialog) => {
      log.info(`Auto-dismiss dialog: "${dialog.message().slice(0, 60)}"`);
      await dialog.accept();
    });
    try {
      await p.setRequestInterception(true);
      p.on("request", (req) => {
        if (BLOCKED_DOMAINS.some((d) => req.url().includes(d))) {
          req.abort();
        } else {
          req.continue();
        }
      });
    } catch {}
  };

  browser.on("targetcreated", async (target) => {
    try {
      const p = await target.page();
      if (p) await setupPage(p);
    } catch {}
  });

  const pages = await browser.pages();
  for (const p of pages) await setupPage(p);

  return browser;
}

// ── Login Onet ──
async function loginOnet(page, email, password) {
  log.info(`Login: ${email}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (attempt > 1) {
        log.warn(`Login retry ${attempt}/3...`);
        await delay(3000);
      }

      await safeGoto(page, URLS.LOGIN);
      await delay(3000);

      // Email
      await page.waitForSelector("#email", { visible: true, timeout: 15000 });
      await page.click("#email", { clickCount: 3 });
      await page.type("#email", email, { delay: 50 });
      await delay(500);
      await page.click('button[type="submit"]');
      log.ok("Email → Next");
      await delay(3000);

      // Password
      await page.waitForSelector("#password", {
        visible: true,
        timeout: 15000,
      });
      await page.click("#password", { clickCount: 3 });
      await page.type("#password", password, { delay: 50 });
      await delay(500);
      await page.click('button[type="submit"]');
      log.ok("Password → Log in");
      await delay(5000);

      // Monitor post-login
      for (let i = 0; i < 15; i++) {
        await delay(2000);
        let url;
        try {
          url = page.url();
        } catch {
          continue;
        }

        if (
          url.includes("chrome-error://") ||
          url.includes("error-report.com")
        ) {
          log.warn("Adware redirect → reloading...");
          try {
            await page.goto(URLS.MAILBOX, {
              waitUntil: "networkidle2",
              timeout: 30000,
            });
          } catch {}
          await delay(3000);
          continue;
        }

        if (
          url.includes("poczta.onet.pl") &&
          !url.includes("platnosci") &&
          !url.includes("konto.onet.pl")
        ) {
          log.ok("Login OK — mailbox reached");
          return { ok: true };
        }

        // MFA
        if (url.includes("konto.onet.pl/en/mfa")) {
          log.info("MFA → trusted device...");
          try {
            const btn = await page.evaluateHandle(() => {
              for (const b of document.querySelectorAll("button")) {
                if (b.textContent.includes("Add this device as trusted"))
                  return b;
              }
              return null;
            });
            if (btn?.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                btn.asElement().click(),
              ]);
              await delay(3000);
              continue;
            }
          } catch {}
        }

        // Update account
        if (url.includes("konto.onet.pl/en/update-account")) {
          log.info("Update account → Remind later...");
          try {
            const btn = await page.evaluateHandle(() => {
              for (const b of document.querySelectorAll("button")) {
                if (b.textContent.includes("Remind me later")) return b;
              }
              return null;
            });
            if (btn?.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                btn.asElement().click(),
              ]);
              await delay(3000);
              continue;
            }
          } catch {}
        }

        // Plan selection
        if (url.includes("platnosci.poczta.onet.pl")) {
          log.info("Plan selection → free plan...");
          try {
            const btn = await page.evaluateHandle(() => {
              const all = [...document.querySelectorAll("button")].filter(
                (b) =>
                  b.querySelector(".cta__label")?.textContent?.trim() ===
                  "Wybierz",
              );
              return all[all.length - 1] || null;
            });
            if (btn?.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                btn.asElement().click(),
              ]);
              await delay(3000);
              continue;
            }
          } catch {}
        }
      }

      const finalUrl = page.url();
      if (finalUrl.includes("poczta.onet.pl")) {
        log.ok("Login OK");
        return { ok: true };
      }

      log.err(`Login stuck at: ${finalUrl.slice(0, 80)}`);
      return { ok: false, reason: `stuck_at: ${finalUrl.slice(0, 80)}` };
    } catch (e) {
      log.err(`Login error (attempt ${attempt}/3): ${e.message}`);
      if (attempt >= 3) return { ok: false, reason: e.message };
      try {
        await page.goto("about:blank", { timeout: 5000 });
      } catch {}
    }
  }

  return { ok: false, reason: "max_login_retries" };
}

// ── Change Password ──
async function changePassword(page, currentPassword) {
  const newPassword = generateRandomPassword(16);
  log.info(`Changing password → new: ${newPassword}`);

  // Navigate to change password page
  await safeGoto(page, URLS.CHANGE_PASS, { timeout: 30000 });
  await delay(3000);

  // Check đúng trang
  const onPage = await page.evaluate(() => {
    return !!document.querySelector("#currentPassword");
  });
  if (!onPage) {
    log.err("Change password page not loaded");
    return { ok: false, reason: "page_not_loaded" };
  }

  // Fill current password
  await page.waitForSelector("#currentPassword", {
    visible: true,
    timeout: 10000,
  });
  await page.click("#currentPassword", { clickCount: 3 });
  await page.type("#currentPassword", currentPassword, { delay: 50 });
  await delay(500);

  // Fill new password
  await page.click("#newPassword", { clickCount: 3 });
  await page.type("#newPassword", newPassword, { delay: 50 });
  await delay(500);

  // Fill confirm password
  await page.click("#rePassword", { clickCount: 3 });
  await page.type("#rePassword", newPassword, { delay: 50 });
  await delay(1000);

  // Click nút "Zapisz" đầu tiên (button[type="button"] chứa text "Zapisz", KHÔNG phải type="submit")
  log.info("Clicking first Zapisz (save)...");
  const firstClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('button[type="button"]');
    for (const btn of buttons) {
      if (btn.textContent.trim() === "Zapisz") {
        btn.removeAttribute("disabled");
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!firstClicked) {
    // Fallback: enable + click bằng mouse
    log.warn("First Zapisz not found via evaluate — trying mouse click...");
    const btnPos = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        if (btn.textContent.trim() === "Zapisz" && btn.type !== "submit") {
          btn.removeAttribute("disabled");
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    if (btnPos) {
      await page.mouse.click(btnPos.x, btnPos.y);
    } else {
      log.err("Cannot find first Zapisz button");
      return { ok: false, reason: "first_zapisz_not_found" };
    }
  }
  log.ok("First Zapisz clicked");

  // Chờ modal dialog xuất hiện
  log.info("Waiting for confirmation modal...");
  let modalFound = false;
  for (let w = 0; w < 15; w++) {
    await delay(1000);

    // Check error message trước
    const errorMsg = await page
      .evaluate(() => {
        // Check cụ thể currentPasswordError trước
        const pwErr = document.querySelector("#currentPasswordError");
        if (pwErr && pwErr.textContent.trim())
          return "incorrect_password:" + pwErr.textContent.trim();
        const el = document.querySelector('[id$="Error"]');
        return el ? el.textContent.trim() : "";
      })
      .catch(() => "");
    if (errorMsg) {
      if (
        errorMsg.includes("incorrect_password") ||
        errorMsg.includes("Niepoprawne")
      ) {
        log.err(`Current password wrong: ${errorMsg}`);
        return { ok: false, reason: "incorrect_current_password" };
      }
      log.err(`Form error: ${errorMsg}`);
      return { ok: false, reason: `form_error: ${errorMsg.slice(0, 80)}` };
    }

    // Check modal
    const hasModal = await page
      .evaluate(() => {
        const title = document.querySelector(".modal-title");
        return title ? title.textContent.includes("Zmiana hasła") : false;
      })
      .catch(() => false);

    if (hasModal) {
      modalFound = true;
      break;
    }
  }

  if (!modalFound) {
    log.err("Confirmation modal not appeared");
    return { ok: false, reason: "modal_not_appeared" };
  }
  log.ok("Modal appeared");
  await delay(1000);

  // Click nút "Zapisz" thứ 2 trong modal (button[type="submit"])
  log.info("Clicking second Zapisz (submit in modal)...");
  const submitClicked = await page.evaluate(() => {
    const btn = document.querySelector(
      'button[type="submit"].modal__ActionButton-sc-44ba8828-3',
    );
    if (btn) {
      btn.click();
      return true;
    }
    // Fallback: tìm submit button trong modal
    const submitBtns = document.querySelectorAll('button[type="submit"]');
    for (const b of submitBtns) {
      if (b.textContent.trim() === "Zapisz") {
        b.click();
        return true;
      }
    }
    return false;
  });

  if (!submitClicked) {
    log.warn("Submit button not found via evaluate — trying mouse...");
    const submitPos = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"]');
      for (const b of btns) {
        if (b.textContent.trim() === "Zapisz") {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    if (submitPos) {
      await page.mouse.click(submitPos.x, submitPos.y);
    } else {
      log.err("Cannot find submit Zapisz button");
      return { ok: false, reason: "submit_zapisz_not_found" };
    }
  }
  log.ok("Submit Zapisz clicked");
  await delay(5000);

  // Verify — check URL hoặc success message
  const success = await page
    .evaluate(() => {
      const body = document.body?.innerText || "";
      // Thành công thường redirect hoặc hiện thông báo
      return (
        body.includes("Hasło zostało zmienione") ||
        body.includes("Password changed") ||
        body.includes("hasło zostało") ||
        !document.querySelector(".modal-title") // modal đã đóng = thành công
      );
    })
    .catch(() => false);

  if (success) {
    log.ok(`Password changed! New: ${newPassword}`);
    return { ok: true, newPassword };
  }

  // Check lỗi
  const pageText = await page
    .evaluate(() => document.body?.innerText || "")
    .catch(() => "");
  if (pageText.includes("nieprawidłowe") || pageText.includes("incorrect")) {
    return { ok: false, reason: "incorrect_current_password" };
  }

  log.warn("Change not confirmed but modal closed — assuming success");
  return { ok: true, newPassword };
}

// ════════════════════════════════════════════════════════════════════
// WORKER — 1 browser instance xử lý phần accounts của mình
// ════════════════════════════════════════════════════════════════════
async function worker(workerId, accounts) {
  const tag = `[W${workerId}]`;
  const wlog = {
    info: (msg) => log.info(`${tag} ${msg}`),
    ok: (msg) => log.ok(`${tag} ${msg}`),
    warn: (msg) => log.warn(`${tag} ${msg}`),
    err: (msg) => log.err(`${tag} ${msg}`),
  };

  let browser = null;
  try {
    // Offset window position per worker
    const xOffset = (workerId - 1) * 660;
    const origPos = WINDOW_POSITION;
    const [baseX, baseY] = origPos.split(",").map(Number);
    const workerArgs = [`--window-position=${baseX + xOffset},${baseY}`];

    browser = await launchBrowser(workerArgs);
    const page = (await browser.pages())[0];

    if (PROXY) {
      const parts = PROXY.split(":");
      if (parts.length === 4) {
        await page.authenticate({ username: parts[2], password: parts[3] });
      }
    }

    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      wlog.info(`Account ${i + 1}/${accounts.length}: ${acc.email}`);

      const loginResult = await loginOnet(page, acc.email, acc.password, tag);
      if (!loginResult.ok) {
        wlog.err(`Login failed: ${loginResult.reason}`);
        await appendFailed(
          acc.email,
          acc.password,
          `login_failed: ${loginResult.reason}`,
        );
        await removeFromInput(acc.raw);
        continue;
      }

      const changeResult = await changePassword(page, acc.password, tag);
      if (changeResult.ok) {
        await appendDone(acc.email, changeResult.newPassword, acc.password);
        wlog.ok(`Done: ${acc.email} → ${changeResult.newPassword}`);
      } else {
        await appendFailed(acc.email, acc.password, changeResult.reason);
        wlog.err(`Failed: ${acc.email} → ${changeResult.reason}`);
      }
      await removeFromInput(acc.raw);

      // Clear cookies cho account tiếp
      try {
        const client = await page.target().createCDPSession();
        await client.send("Network.clearBrowserCookies");
        await client.send("Network.clearBrowserCache");
        await client.detach();
      } catch {}

      await delay(3000);
    }
  } catch (e) {
    log.err(`${tag} Fatal: ${e.message}`);
    console.error(e);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════
async function main() {
  log.divider("ONET CHANGE PASSWORD TOOL");

  // Ensure data dir
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const accounts = readInput();
  if (!accounts.length) {
    log.err("No accounts in input file!");
    return;
  }
  log.info(`Loaded ${accounts.length} account(s) | Threads: ${THREADS}`);

  // Chia accounts cho các worker
  const chunks = [];
  for (let t = 0; t < THREADS; t++) {
    chunks.push([]);
  }
  accounts.forEach((acc, i) => {
    chunks[i % THREADS].push(acc);
  });

  // Chạy song song
  const workers = [];
  for (let t = 0; t < THREADS; t++) {
    if (chunks[t].length > 0) {
      workers.push(worker(t + 1, chunks[t]));
    }
  }
  await Promise.all(workers);

  log.divider("DONE");
}

main();
