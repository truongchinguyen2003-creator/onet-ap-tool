"use strict";

// ════════════════════════════════════════════════════════════════════
// onet.js — Onet.pl automation: login, alias, read mail (no IMAP)
// Puppeteer-based, all UI interaction
// ════════════════════════════════════════════════════════════════════

const { delay, log } = require("./utils");

const SELECTORS = {
  // Login
  LOGIN_EMAIL: "#email",
  LOGIN_PASSWORD: "#password",
  LOGIN_NEXT: 'button[type="submit"]',

  // Alias
  ALIAS_TILE: ".styles__TileCol-sc-19455r0-1",
  ALIAS_VALUE: ".styles__Value-sc-14c2vid-2",

  // Mail list
  MAIL_ITEM: "li.list-item",
};

const URLS = {
  LOGIN:
    "https://konto.onet.pl/en/signin?state=https%3A%2F%2Fpoczta.onet.pl%2F&client_id=poczta.onet.pl.front.onetapi.pl",
  ALIAS_SETTINGS: "https://ustawienia.poczta.onet.pl/Konto/AlternatywneAdresy",
  NOTIFICATIONS: "https://poczta.onet.pl/Powiadomienia",
  SPAM: "https://poczta.onet.pl/Spam",
  MAILBOX: "https://poczta.onet.pl/",
  readMail: (id) => `https://poczta.onet.pl/Czytaj/_mid/${id}`,
};

const MAX_ALIAS_FIRST_BATCH = 3; // first batch: 3 aliases
const MAX_ALIAS_SECOND_BATCH = 2; // after delete: 2 more
const MAX_ALIAS_TOTAL = 5; // total per main account

// ════════════════════════════════════════════════════════════════════
// HELPER: Navigate with retry (handle transient network errors)
// ════════════════════════════════════════════════════════════════════
const RETRYABLE_NAV_ERRORS = [
  "ERR_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_EMPTY_RESPONSE",
  "ERR_NETWORK_CHANGED",
  "ERR_TIMED_OUT",
  "ERR_TOO_MANY_REDIRECTS",
  "ERR_INTERNET_DISCONNECTED",
  "Timeout",
  "timeout",
];

function isRetryableNavError(msg) {
  return RETRYABLE_NAV_ERRORS.some((err) => msg.includes(err));
}

async function safeGoto(page, url, opts = {}, maxRetries = 3) {
  const defaults = { waitUntil: "networkidle2", timeout: 30000 };
  const navOpts = { ...defaults, ...opts };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, navOpts);
    } catch (e) {
      if (isRetryableNavError(e.message) && attempt < maxRetries) {
        log.warn(
          `Nav error (attempt ${attempt}/${maxRetries}): ${e.message.slice(0, 60)} → ${url.slice(0, 60)} — retrying...`,
        );
        await delay(3000);
        continue;
      }
      throw e;
    }

    // Check chrome-error (adware redirect) → retry
    const currentUrl = page.url();
    if (currentUrl.includes("chrome-error://")) {
      if (attempt < maxRetries) {
        log.warn(
          `chrome-error detected (attempt ${attempt}/${maxRetries}): ${url.slice(0, 60)} — retrying...`,
        );
        await delay(2000);
        continue;
      }
      throw new Error(`chrome-error after ${maxRetries} attempts: ${url}`);
    }

    return;
  }
}

// ════════════════════════════════════════════════════════════════════
// Dismiss GDPR/cookie consent popup (onet.pl)
// Button: "Przejdź do serwisu" (class cmp-intro_acceptAll)
// ════════════════════════════════════════════════════════════════════
async function dismissGdprPopup(page) {
  try {
    const dismissed = await page.evaluate(() => {
      // Tìm button "Przejdź do serwisu" bằng class
      const btn = document.querySelector("button.cmp-intro_acceptAll");
      if (btn) {
        btn.click();
        return true;
      }
      // Fallback: tìm bằng aria-label
      const btns = document.querySelectorAll(
        'button[aria-label="Przejdź do serwisu"]',
      );
      if (btns.length > 0) {
        btns[0].click();
        return true;
      }
      return false;
    });
    if (dismissed) {
      log.info("Dismissed GDPR/cookie consent popup");
      await delay(2000);
    }
  } catch {}
}

// ════════════════════════════════════════════════════════════════════
// LOGIN — multi-step: email → next → password → login → monitors
// ════════════════════════════════════════════════════════════════════
async function loginOnet(page, email, password) {
  log.info(`Login onet.pl: ${email}`);
  resetFolderCache(); // account mới → folderId khác

  const MAX_LOGIN_RETRIES = 3;

  for (
    let loginAttempt = 1;
    loginAttempt <= MAX_LOGIN_RETRIES;
    loginAttempt++
  ) {
    try {
      if (loginAttempt > 1) {
        log.warn(`Login retry ${loginAttempt}/${MAX_LOGIN_RETRIES}...`);
        await delay(3000);
      }

      // ── B1: Truy cập login page ──
      log.info("B1: Loading login page...");
      await safeGoto(page, URLS.LOGIN, { timeout: 30000 });
      await delay(3000);

      // Dismiss GDPR/cookie consent popup nếu có
      await dismissGdprPopup(page);

      // ── B2: Nhập email → bấm Next ──
      log.info("B2: Entering email...");
      await page.waitForSelector(SELECTORS.LOGIN_EMAIL, {
        visible: true,
        timeout: 15000,
      });
      await page.click(SELECTORS.LOGIN_EMAIL, { clickCount: 3 });
      await page.type(SELECTORS.LOGIN_EMAIL, email, { delay: 50 });
      await delay(500);

      await page.click(SELECTORS.LOGIN_NEXT);
      log.ok("Email entered → clicked Next");
      await delay(3000);

      // Check IP blocked after Next
      const ipBlockedB2 = await page
        .evaluate(() => {
          const err = document.querySelector("#passwordError");
          return (
            err && err.textContent.includes("Too many failed login attempts")
          );
        })
        .catch(() => false);
      if (ipBlockedB2) {
        log.err("IP blocked (Too many failed login attempts) — need relaunch");
        return { ok: false, reason: "ip_blocked_need_relaunch" };
      }

      // ── B3: Đợi ô password hiện → nhập pass → bấm Log in ──
      log.info("B3: Entering password...");
      await dismissGdprPopup(page);
      await page.waitForSelector(SELECTORS.LOGIN_PASSWORD, {
        visible: true,
        timeout: 15000,
      });
      await dismissGdprPopup(page);
      await page.click(SELECTORS.LOGIN_PASSWORD, { clickCount: 3 });
      await page.type(SELECTORS.LOGIN_PASSWORD, password, { delay: 50 });
      await delay(500);

      await dismissGdprPopup(page);
      await page.click(SELECTORS.LOGIN_NEXT);
      log.ok("Password entered → clicked Log in");
      await delay(5000);

      // Check IP blocked after Log in
      const ipBlockedB3 = await page
        .evaluate(() => {
          const err = document.querySelector("#passwordError");
          return (
            err && err.textContent.includes("Too many failed login attempts")
          );
        })
        .catch(() => false);
      if (ipBlockedB3) {
        log.err("IP blocked (Too many failed login attempts) — need relaunch");
        return { ok: false, reason: "ip_blocked_need_relaunch" };
      }

      // ── B4: Monitor post-login pages ──
      log.info("B4: Monitoring post-login...");
      const maxMonitorAttempts = 15;
      let loginReClickCount = 0;
      const MAX_LOGIN_RECLICKS = 3;
      for (let i = 0; i < maxMonitorAttempts; i++) {
        await delay(2000);

        // Dismiss GDPR popup nếu xuất hiện
        await dismissGdprPopup(page);

        // Check lỗi password sai hoặc IP blocked
        const loginError = await page
          .evaluate(() => {
            const err = document.querySelector("#passwordError");
            if (!err) return null;
            const text = err.textContent.trim();
            if (!text) return null;
            return text;
          })
          .catch(() => null);
        if (loginError) {
          if (loginError.includes("Too many failed login attempts")) {
            log.err(`IP blocked: ${loginError}`);
            return { ok: false, reason: "ip_blocked_need_relaunch" };
          }
          // Password sai hoặc lỗi khác
          log.err(`Login error: ${loginError}`);
          return {
            ok: false,
            reason: `login_error: ${loginError.slice(0, 80)}`,
          };
        }

        // Nếu vẫn trên trang login (có ô password + nút submit) → click Log in lại (max 3 lần)
        const stillOnLogin = await page
          .evaluate(() => {
            const pwdField = document.querySelector("#password");
            const submitBtn = document.querySelector('button[type="submit"]');
            return !!(pwdField && submitBtn);
          })
          .catch(() => false);
        if (stillOnLogin) {
          loginReClickCount++;
          if (loginReClickCount > MAX_LOGIN_RECLICKS) {
            log.err(
              `Still on login page after ${MAX_LOGIN_RECLICKS} re-clicks — giving up`,
            );
            return { ok: false, reason: "login_stuck_on_page" };
          }
          log.warn(
            `Still on login page — re-clicking Log in (${loginReClickCount}/${MAX_LOGIN_RECLICKS})...`,
          );
          await dismissGdprPopup(page);
          await page.click(SELECTORS.LOGIN_NEXT).catch(() => {});
          await delay(3000);
          continue;
        }

        let currentUrl;
        try {
          currentUrl = page.url();
        } catch {
          log.warn("Page URL not accessible, waiting...");
          await delay(3000);
          continue;
        }

        // chrome-error = bị redirect do adware → reload mailbox
        if (currentUrl.includes("chrome-error://")) {
          log.warn(
            "chrome-error detected (adware redirect) → reloading mailbox...",
          );
          try {
            await page.goto(URLS.MAILBOX, {
              waitUntil: "networkidle2",
              timeout: 30000,
            });
          } catch {}
          await delay(3000);
          continue;
        }

        // error-report.com redirect → reload mailbox
        if (currentUrl.includes("error-report.com")) {
          log.warn("Adware redirect detected → reloading mailbox...");
          try {
            await page.goto(URLS.MAILBOX, {
              waitUntil: "networkidle2",
              timeout: 30000,
            });
          } catch {}
          await delay(3000);
          continue;
        }

        // ✅ Đã vào mailbox
        if (
          currentUrl.includes("poczta.onet.pl") &&
          !currentUrl.includes("platnosci") &&
          !currentUrl.includes("konto.onet.pl")
        ) {
          log.ok("Login OK — reached mailbox");
          return { ok: true };
        }

        // MFA trusted device
        if (currentUrl.includes("konto.onet.pl/en/mfa")) {
          log.info("MFA page → clicking 'Add this device as trusted'...");
          try {
            const trustedBtn = await page.evaluateHandle(() => {
              const buttons = document.querySelectorAll("button");
              for (const btn of buttons) {
                if (btn.textContent.includes("Add this device as trusted"))
                  return btn;
              }
              return null;
            });
            if (trustedBtn && trustedBtn.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                trustedBtn.asElement().click(),
              ]);
              log.ok("Clicked trusted device");
              await delay(3000);
              continue;
            }
          } catch (e) {
            log.warn(`MFA click error: ${e.message}`);
            await delay(3000);
            continue;
          }
        }

        // Update account reminder
        if (currentUrl.includes("konto.onet.pl/en/update-account")) {
          log.info("Update account → clicking 'Remind me later'...");
          try {
            const remindBtn = await page.evaluateHandle(() => {
              const buttons = document.querySelectorAll("button");
              for (const btn of buttons) {
                if (btn.textContent.includes("Remind me later")) return btn;
              }
              return null;
            });
            if (remindBtn && remindBtn.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                remindBtn.asElement().click(),
              ]);
              log.ok("Clicked Remind me later");
              await delay(3000);
              continue;
            }
          } catch (e) {
            log.warn(`Remind later click error: ${e.message}`);
            await delay(3000);
            continue;
          }
        }

        // Plan selection page
        if (currentUrl.includes("platnosci.poczta.onet.pl")) {
          log.info("Plan selection → choosing free plan...");
          try {
            const freeBtn = await page.evaluateHandle(() => {
              const buttons = document.querySelectorAll("button");
              for (const btn of buttons) {
                const label = btn.textContent;
                if (label.includes("Wybierz") && label.includes("Bez opłat"))
                  return btn;
              }
              const allWybierz = [
                ...document.querySelectorAll("button"),
              ].filter(
                (b) =>
                  b.querySelector(".cta__label")?.textContent?.trim() ===
                  "Wybierz",
              );
              return allWybierz[allWybierz.length - 1] || null;
            });
            if (freeBtn && freeBtn.asElement()) {
              await Promise.all([
                page
                  .waitForNavigation({
                    waitUntil: "networkidle2",
                    timeout: 15000,
                  })
                  .catch(() => {}),
                freeBtn.asElement().click(),
              ]);
              log.ok("Selected free plan");
              await delay(3000);
              continue;
            }
          } catch (e) {
            log.warn(`Plan selection error: ${e.message}`);
            await delay(3000);
            continue;
          }
        }

        await delay(2000);
      }

      const finalUrl = page.url();
      if (finalUrl.includes("poczta.onet.pl")) {
        log.ok("Login OK — reached mailbox after monitors");
        return { ok: true };
      }

      log.err(`Login failed — stuck at: ${finalUrl}`);
      return { ok: false, reason: `stuck_at: ${finalUrl.slice(0, 80)}` };
    } catch (e) {
      log.err(
        `Login error (attempt ${loginAttempt}/${MAX_LOGIN_RETRIES}): ${e.message}`,
      );
      if (loginAttempt >= MAX_LOGIN_RETRIES) {
        return { ok: false, reason: e.message };
      }
      // Retry: reload về login page
      try {
        await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
      } catch {}
      continue;
    }
  } // end for loginAttempt

  return { ok: false, reason: "max_login_retries" };
}

// ════════════════════════════════════════════════════════════════════
// GET EXISTING ALIASES — API + UI fallback
// ════════════════════════════════════════════════════════════════════
async function getExistingAliases(page) {
  log.info("Getting existing aliases via API...");

  try {
    // Luôn navigate đến trang alias settings trước khi gọi API
    await safeGoto(page, URLS.ALIAS_SETTINGS, { timeout: 30000 });
    await delay(3000);

    const apiResult = await page.evaluate(async () => {
      try {
        const res = await fetch("https://ustawienia.poczta.onet.pl/api/alias", {
          method: "GET",
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        if (res.status === 200) {
          return await res.json();
        }
        return { error: `http_${res.status}` };
      } catch (e) {
        return { error: e.message };
      }
    });

    if (!apiResult.error) {
      const aliases = (apiResult.aliases || []).map((a) => a.alias);
      const limit = apiResult.limit || 3;
      log.info(
        `Found ${aliases.length}/${limit} alias(es): ${aliases.join(", ") || "(none)"}`,
      );
      return { aliases, limit };
    }

    log.warn(`API error: ${apiResult.error} → fallback to UI`);
  } catch (e) {
    log.warn(`getExistingAliases API exception: ${e.message} → fallback to UI`);
  }

  // ── Fallback: đọc từ UI ──
  return await getExistingAliasesFromUI(page);
}

async function getExistingAliasesFromUI(page) {
  log.info("Getting aliases from UI...");

  try {
    await safeGoto(page, URLS.ALIAS_SETTINGS, { timeout: 30000 });
    await delay(3000);

    const aliases = await page.evaluate(() => {
      const results = [];
      const allText = document.body.innerText;
      const matches = allText.match(
        /\b[\w][\w.-]*@(?:onet|op|interia|poczta)\.\w+/gi,
      );
      if (matches) {
        for (const m of matches) {
          const clean = m.replace(/^[A-Z][a-z]+(?=[a-z])/, (prefix) => {
            if (/^Alias$/i.test(prefix)) return "";
            return prefix;
          });
          const emailMatch = clean.match(/[\w][\w.-]*@[\w.-]+\.\w+/);
          if (emailMatch && !results.includes(emailMatch[0])) {
            results.push(emailMatch[0]);
          }
        }
      }
      return results;
    });

    log.info(
      `UI found ${aliases.length} alias(es): ${aliases.join(", ") || "(none)"}`,
    );
    return { aliases, limit: 3 };
  } catch (e) {
    log.err(`getExistingAliasesFromUI error: ${e.message}`);
    return { aliases: [], limit: 3 };
  }
}

// ════════════════════════════════════════════════════════════════════
// ADD SINGLE ALIAS — via API (POST /api/alias)
// ════════════════════════════════════════════════════════════════════
async function addSingleAlias(page, aliasEmail) {
  log.info(`Adding alias via API: ${aliasEmail}`);

  try {
    const atIndex = aliasEmail.indexOf("@");
    if (atIndex === -1) {
      log.err(`Invalid email format: ${aliasEmail}`);
      return { ok: false, reason: "invalid_email" };
    }
    const login = aliasEmail.substring(0, atIndex);
    const domain = aliasEmail.substring(atIndex + 1);

    // Đảm bảo đang ở trang onet
    const currentUrl = page.url();
    if (!currentUrl.includes("onet.pl")) {
      await safeGoto(page, URLS.ALIAS_SETTINGS, { timeout: 30000 });
      await delay(2000);
    }

    const apiResult = await page.evaluate(
      async (loginVal, domainVal) => {
        try {
          const res = await fetch(
            "https://ustawienia.poczta.onet.pl/api/alias",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ domain: domainVal, login: loginVal }),
              credentials: "include",
            },
          );
          const status = res.status;
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return { status, data };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      login,
      domain,
    );

    log.info(
      `API response: status=${apiResult.status}, data=${JSON.stringify(apiResult.data)}`,
    );

    // 201 Created + { status: 1, data: "OK" } = thành công
    if (apiResult.status === 201 && apiResult.data?.status === 1) {
      log.ok(`Alias added: ${aliasEmail}`);
      return { ok: true };
    }

    // 409 Conflict = email đã được dùng rồi → fail mail làm
    if (apiResult.status === 409) {
      log.warn(`Alias conflict (409) — email already taken: ${aliasEmail}`);
      return { ok: false, reason: "conflict_409" };
    }

    // 405 Method Not Allowed = mail chính bị limit → giữ mail làm
    if (apiResult.status === 405) {
      log.err(`Main account quota exhausted (405) — cannot add more aliases`);
      return { ok: false, reason: "quota_exhausted_405", quotaExhausted: true };
    }

    // 406 Not Acceptable = mail chính bị limit/block alias → giữ mail làm
    if (apiResult.status === 406) {
      log.err(`Main account alias limit (406) — cannot add more aliases`);
      return { ok: false, reason: "quota_exhausted_406", quotaExhausted: true };
    }

    // 403 Forbidden = proxy IP không phải PL → cần relaunch browser
    if (apiResult.status === 403) {
      log.err(`Proxy not PL (403) — need browser relaunch for: ${aliasEmail}`);
      return { ok: false, reason: "proxy_403", proxyError: true };
    }

    // 504 Gateway Timeout → reload trang alias rồi retry
    if (apiResult.status === 504) {
      log.warn(`Gateway Timeout (504) — need reload alias page: ${aliasEmail}`);
      return { ok: false, reason: "gateway_timeout_504", gatewayError: true };
    }

    // Status 0 = network error (proxy die, fetch failed) → KHÔNG phải lỗi email
    if (apiResult.status === 0) {
      log.err(`Network error (proxy die?) — fetch failed for: ${aliasEmail}`);
      return { ok: false, reason: "network_error", networkError: true };
    }

    const reason =
      apiResult.error ||
      `http_${apiResult.status}_${JSON.stringify(apiResult.data)}`;
    log.warn(`Alias add failed (${apiResult.status}): ${reason}`);
    return { ok: false, reason: reason.slice(0, 120) };
  } catch (e) {
    log.err(`addSingleAlias error: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
// ADD ALIAS BATCH — add cho đến khi đủ targetCount thành công
// Nếu 1 email fail (409...) → lấy email tiếp từ pool
// Returns: { added: ["a@onet.pl", ...], failed: ["b@op.pl", ...] }
// ════════════════════════════════════════════════════════════════════
async function addAliasBatch(page, targetCount, emailPool) {
  log.info(
    `Adding aliases — target: ${targetCount}, pool size: ${emailPool.length}`,
  );

  // Đảm bảo đang ở trang alias settings + đợi API sẵn sàng
  await safeGoto(page, URLS.ALIAS_SETTINGS, { timeout: 30000 });
  await delay(3000);

  const added = []; // emails thành công (201)
  const failed = []; // emails fail 409 (mail làm lỗi → xóa khỏi pool)
  const skipped405 = []; // emails bị 405 (lỗi mail chính → giữ lại pool)
  let poolIndex = 0;
  let quotaExhausted = false;
  let count405 = 0;

  let networkErrorCount = 0;
  let gatewayErrorCount = 0;
  const MAX_GATEWAY_RETRIES = 3;

  while (added.length < targetCount && poolIndex < emailPool.length) {
    const email = emailPool[poolIndex];
    poolIndex++;

    const result = await addSingleAlias(page, email);
    if (result.ok) {
      added.push(email);
      count405 = 0;
      networkErrorCount = 0;
      gatewayErrorCount = 0;
    } else if (result.proxyError) {
      // 403 = proxy IP không phải PL → dừng batch, giữ email, cần relaunch browser
      log.err(`Proxy error (403) — stopping batch, need Onet browser relaunch`);
      poolIndex--; // giữ lại email này
      return {
        added,
        failed,
        skipped405,
        consumed: poolIndex,
        quotaExhausted: false,
        proxyError: true,
      };
    } else if (result.gatewayError) {
      // 504 Gateway Timeout → reload trang alias rồi retry (max 3 lần)
      gatewayErrorCount++;
      if (gatewayErrorCount > MAX_GATEWAY_RETRIES) {
        log.err(
          `504 x${gatewayErrorCount} on ${email} — stopping batch, email preserved`,
        );
        poolIndex--; // giữ lại email này
        break;
      }
      log.warn(
        `504 on ${email} (${gatewayErrorCount}/${MAX_GATEWAY_RETRIES}) — reloading alias page and retrying...`,
      );
      poolIndex--; // quay lại email này
      try {
        await safeGoto(page, URLS.ALIAS_SETTINGS, { timeout: 30000 });
        await delay(3000);
      } catch (e) {
        log.err(`Reload alias page failed: ${e.message} — stopping batch`);
        break;
      }
      continue;
    } else if (result.networkError) {
      // Proxy die / fetch failed → KHÔNG push vào failed (giữ email trong pool)
      networkErrorCount++;
      if (networkErrorCount >= 3) {
        log.err(
          `3x network error (proxy die?) — stopping batch, emails preserved`,
        );
        break;
      }
      log.warn(
        `Network error on ${email} (${networkErrorCount}/3) — waiting 10s before retry...`,
      );
      poolIndex--; // quay lại email này để retry
      await delay(10000);
      continue;
    } else if (result.quotaExhausted) {
      // 405/406 = quota hết → email KHÔNG có lỗi, chỉ là main account hết slot
      // KHÔNG push vào failed — giữ email trong pool để main account khác dùng
      log.err(
        `405/406 quota exhausted — email ${email} preserved in pool, stopping batch`,
      );
      poolIndex--; // giữ lại email này trong pool
      quotaExhausted = true;
      break;
    } else {
      failed.push(email);
    }
    await delay(1500);
  }

  log.info(
    `Batch done: ${added.length}/${targetCount} added, ${failed.length} failed (409), ${skipped405.length} skipped (405)${quotaExhausted ? " [QUOTA EXHAUSTED]" : ""}`,
  );
  return { added, failed, skipped405, consumed: poolIndex, quotaExhausted };
}

// ════════════════════════════════════════════════════════════════════
// DELETE SINGLE ALIAS — via API (DELETE /api/alias)
// ════════════════════════════════════════════════════════════════════
async function deleteSingleAlias(page, aliasEmail) {
  log.info(`Deleting alias via API: ${aliasEmail}`);

  try {
    const atIndex = aliasEmail.indexOf("@");
    if (atIndex === -1) {
      log.err(`Invalid email format: ${aliasEmail}`);
      return { ok: false, reason: "invalid_email" };
    }
    const login = aliasEmail.substring(0, atIndex);
    const domain = aliasEmail.substring(atIndex + 1);

    const apiResult = await page.evaluate(
      async (loginVal, domainVal) => {
        try {
          const res = await fetch(
            "https://ustawienia.poczta.onet.pl/api/alias",
            {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ domain: domainVal, login: loginVal }),
              credentials: "include",
            },
          );
          const status = res.status;
          let data = null;
          try {
            data = await res.json();
          } catch {}
          return { status, data };
        } catch (e) {
          return { status: 0, error: e.message };
        }
      },
      login,
      domain,
    );

    log.info(
      `Delete API: status=${apiResult.status}, data=${JSON.stringify(apiResult.data)}`,
    );

    if (apiResult.status === 200 && apiResult.data?.status === 1) {
      log.ok(`Deleted: ${aliasEmail}`);
      return { ok: true };
    }

    const reason =
      apiResult.error ||
      `http_${apiResult.status}_${JSON.stringify(apiResult.data)}`;
    log.warn(`Delete failed: ${reason}`);
    return { ok: false, reason: reason.slice(0, 120) };
  } catch (e) {
    log.err(`deleteSingleAlias error: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ════════════════════════════════════════════════════════════════════
// DELETE ALL ALIASES — API + UI fallback
// ════════════════════════════════════════════════════════════════════
async function deleteAllAliases(page) {
  log.info("Deleting all aliases...");

  const { aliases } = await getExistingAliases(page);

  if (!aliases.length) {
    log.info("No aliases to delete");
    return { ok: true, deleted: 0 };
  }

  let deleted = 0;
  for (const alias of aliases) {
    const result = await deleteSingleAlias(page, alias);
    if (result.ok) deleted++;
    await delay(1000);
  }

  // Verify — nếu API delete xong mà vẫn còn, thử lại 1 lần
  if (deleted < aliases.length) {
    log.warn(`Only deleted ${deleted}/${aliases.length}, verifying...`);
    const recheck = await getExistingAliases(page);
    if (recheck.aliases.length > 0) {
      log.warn(
        `Still ${recheck.aliases.length} alias(es) remaining, retrying...`,
      );
      for (const alias of recheck.aliases) {
        const r = await deleteSingleAlias(page, alias);
        if (r.ok) deleted++;
        await delay(1000);
      }
    }
  }

  log.ok(`Deleted ${deleted}/${aliases.length} aliases`);
  return { ok: true, deleted };
}

// ════════════════════════════════════════════════════════════════════
// ONET MAIL API — dùng API thay vì DOM scraping
// ════════════════════════════════════════════════════════════════════

const MAIL_API_BASE = "https://api.poczta.onet.pl/webmailapi/mail";

/**
 * Gọi Onet mail API từ trong browser context (dùng fetch với cookies sẵn có)
 */
async function callMailApi(page, apiUrl) {
  try {
    return await Promise.race([
      page.evaluate(async (url) => {
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 25000);
          const res = await fetch(url, {
            method: "GET",
            credentials: "include",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
          clearTimeout(tid);
          if (!res.ok)
            return {
              _error: true,
              status: res.status,
              statusText: res.statusText,
            };
          return res.json();
        } catch (e) {
          return { _error: true, message: e.message };
        }
      }, apiUrl),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("callMailApi timeout 30s")), 30000),
      ),
    ]);
  } catch (e) {
    log.warn(`[API] callMailApi timed out: ${e.message}`);
    return { _error: true, message: e.message };
  }
}

/**
 * Navigate vào folder page, intercept API call để lấy folderId,
 * rồi dùng API đọc mail list
 */
let _folderIdCache = {}; // { folderName: folderId }

function resetFolderCache() {
  _folderIdCache = {};
}

/**
 * Lấy folderId bằng cách navigate vào folder page và bắt API request.
 * Trả về { folderId, mails } — mails là data intercepted từ webapp (nếu có).
 */
async function getFolderId(page, folderName) {
  // Nếu đã cache, chỉ trả folderId, không có mails (sẽ gọi API riêng)
  if (_folderIdCache[folderName]) {
    return { folderId: _folderIdCache[folderName], mails: null };
  }

  const folderUrl =
    folderName === "Spam"
      ? URLS.SPAM
      : folderName === "Inbox"
        ? URLS.MAILBOX
        : URLS.NOTIFICATIONS;

  log.info(`[API] Getting folderId for ${folderName} via page navigation...`);

  // Bắt API response từ webapp khi navigate vào folder
  let capturedFolderId = null;
  let capturedMails = null;

  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes("api.poczta.onet.pl/webmailapi/mail")) return;
    if (url.includes("/mail/")) return; // skip detail calls /mail/{id}

    try {
      const urlObj = new URL(url);
      const fid = urlObj.searchParams.get("folderId");
      const fname = urlObj.searchParams.get("folderName");

      if (fid) {
        // Capture folderId — nếu folderName match thì tốt, nếu không thì vẫn lưu
        if (!fname || fname === folderName) {
          capturedFolderId = fid;
        }
        // Cũng lấy luôn response data
        try {
          const data = await response.json();
          if (data && !data._error && data.mails) {
            capturedMails = data;
          }
        } catch {}
      }
    } catch {}
  };

  page.on("response", responseHandler);

  try {
    await safeGoto(page, folderUrl, { timeout: 30000 });
    // Đợi webapp load và gọi API
    await delay(5000);
  } catch (e) {
    log.warn(
      `[API] Navigation to ${folderName} failed: ${e.message.slice(0, 80)}`,
    );
  }

  page.off("response", responseHandler);

  if (capturedFolderId) {
    log.info(`[API] Captured folderId for ${folderName}: ${capturedFolderId}`);
    _folderIdCache[folderName] = capturedFolderId;
  } else {
    log.warn(
      `[API] Could not capture folderId for ${folderName} — will try fetching without it`,
    );
  }

  return { folderId: capturedFolderId, mails: capturedMails };
}

/**
 * List mail trong 1 folder qua API, trả về mails[] từ Apple
 */
async function findAppleEmailInFolder(page, folderUrl, folderName) {
  // Bước 1: lấy folderId (navigate + intercept)
  const { folderId, mails: interceptedData } = await getFolderId(
    page,
    folderName,
  );

  let data = interceptedData;

  // Nếu đã intercept được data từ navigate, dùng luôn
  if (!data) {
    let apiUrl;
    if (folderId) {
      apiUrl = `${MAIL_API_BASE}?withTotalCount=1&offset=0&sort=date&sortDir=desc&folderName=${encodeURIComponent(folderName)}&folderId=${folderId}&limit=30`;
      log.info(`[API] Fetching ${folderName} (folderId=${folderId})...`);
    } else {
      // No folderId — try with folderName only
      apiUrl = `${MAIL_API_BASE}?withTotalCount=1&offset=0&sort=date&sortDir=desc&folderName=${encodeURIComponent(folderName)}&limit=30`;
      log.info(
        `[API] Fetching ${folderName} (no folderId, folderName only)...`,
      );
    }
    data = await callMailApi(page, apiUrl);
  }

  if (!data || data._error) {
    log.warn(`[API] ${folderName}: API error — ${JSON.stringify(data)}`);
    return [];
  }

  const mails = data.mails || [];
  log.info(
    `[API] ${folderName}: ${mails.length} mail(s), total_count=${data.total_count || 0}`,
  );

  // Lọc mail từ Apple (from chứa "apple")
  const appleMailIds = mails
    .filter((m) => {
      const fromStr = typeof m.from === "string" ? m.from.toLowerCase() : "";
      const fromEmail = (m.from?.email || "").toLowerCase();
      const fromName = (m.from?.name || "").toLowerCase();
      return (
        fromStr.includes("apple") ||
        fromEmail.includes("apple") ||
        fromName.includes("apple")
      );
    })
    .map((m) => String(m.mid));

  if (appleMailIds.length > 0) {
    log.ok(
      `[API] Found ${appleMailIds.length} Apple email(s) in ${folderName} — IDs: ${appleMailIds.join(", ")}`,
    );
  } else if (mails.length > 0) {
    const senders = mails
      .slice(0, 3)
      .map((m) =>
        typeof m.from === "string"
          ? m.from
          : `${m.from?.name} <${m.from?.email}>`,
      );
    log.info(
      `[API] ${folderName}: no Apple mail. Top senders: ${senders.join(" | ")}`,
    );
  }
  return appleMailIds;
}

// ════════════════════════════════════════════════════════════════════
// GET APPLE RESET LINK — API-based: list → detail → extract link
// ════════════════════════════════════════════════════════════════════
async function getAppleResetLink(
  page,
  targetEmail = null,
  maxRetries = 5,
  retryDelay = 5000,
) {
  log.info(
    `Looking for Apple reset email${targetEmail ? ` for: ${targetEmail}` : ""}...`,
  );

  // Không reset folder cache ở đây — folderId không đổi trong cùng account
  // Cache chỉ reset khi login account mới (trong loginOnet)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log.info(`Attempt ${attempt}/${maxRetries}...`);

    // ── List mail Powiadomienia qua API ──
    let mailIds = await findAppleEmailInFolder(page, null, "Powiadomienia");

    // Fallback: check Spam
    if (mailIds.length === 0) {
      log.info("Not in Powiadomienia → checking Spam...");
      mailIds = await findAppleEmailInFolder(page, null, "Spam");
    }

    // Fallback 2: check Inbox (INBOX)
    if (mailIds.length === 0) {
      log.info("Not in Spam → checking Inbox...");
      mailIds = await findAppleEmailInFolder(page, null, "Inbox");
    }

    if (mailIds.length === 0) {
      log.warn(
        `No Apple email found yet, retrying in ${retryDelay / 1000}s...`,
      );
      await delay(retryDelay);
      continue;
    }

    // Lấy mail đầu tiên (mới nhất)
    const mailId = mailIds[0];
    log.info(`[API] Reading mail detail ID: ${mailId}...`);

    // ── Đọc mail detail qua API ──
    const detailUrl = `${MAIL_API_BASE}/${mailId}`;
    const detail = await callMailApi(page, detailUrl);
    if (!detail || detail._error) {
      log.warn(`[API] Mail detail error: ${JSON.stringify(detail)}`);
      await delay(retryDelay);
      continue;
    }

    // Extract reset link từ html field
    const html = detail.html || "";
    const text = detail.text || "";

    let resetLink = null;

    // Tìm link iforgot.apple.com/verify/email trong HTML
    const htmlMatch = html.match(
      /https?:\/\/iforgot\.apple\.com\/verify\/email[^\s"'<>]+/,
    );
    if (htmlMatch) {
      resetLink = htmlMatch[0];
    }

    // Fallback: tìm trong text field
    if (!resetLink) {
      const textMatch = text.match(
        /https?:\/\/iforgot\.apple\.com\/verify\/email[^\s"'<>]+/,
      );
      if (textMatch) {
        resetLink = textMatch[0];
      }
    }

    // Fallback: tìm link iforgot.apple.com/password/verify
    if (!resetLink) {
      const altMatch = (html + " " + text).match(
        /https?:\/\/iforgot\.apple\.com\/password\/verify[^\s"'<>]+/,
      );
      if (altMatch) {
        resetLink = altMatch[0];
      }
    }

    if (resetLink) {
      // Decode HTML entities nếu có
      resetLink = resetLink.replace(/&amp;/g, "&");
      log.ok(`[API] Reset link found: ${resetLink.slice(0, 100)}...`);
      return { ok: true, resetLink };
    }

    // Log subject để debug
    log.warn(
      `[API] Mail ${mailId} (subject: "${detail.subject || "?"}"): no reset link found, retrying in ${retryDelay / 1000}s...`,
    );
    await delay(retryDelay);
  }

  log.err(`No Apple reset email found after ${maxRetries} attempts`);
  return { ok: false, reason: "no_email" };
}

module.exports = {
  loginOnet,
  getExistingAliases,
  addSingleAlias,
  addAliasBatch,
  deleteSingleAlias,
  deleteAllAliases,
  getAppleResetLink,
  findAppleEmailInFolder,
  resetFolderCache,
  MAX_ALIAS_FIRST_BATCH,
  MAX_ALIAS_SECOND_BATCH,
  MAX_ALIAS_TOTAL,
};
