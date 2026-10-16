"use strict";

// ════════════════════════════════════════════════════════════════════
// apple-forgot.js — Apple iForgot + CAPTCHA + Password Reset
// ════════════════════════════════════════════════════════════════════

const { delay, randomDelay, log } = require("./utils");

/**
 * Generate random password đảm bảo:
 * - Có upper, lower, number, special
 * - Không có 2+ ký tự giống nhau liên tiếp
 */
function generateRandomPassword(length = 18) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;

  for (let attempt = 0; attempt < 50; attempt++) {
    // 1 upper + 1 lower + 1 digit + 1 dấu #
    const arr = [
      upper[Math.floor(Math.random() * upper.length)],
      lower[Math.floor(Math.random() * lower.length)],
      digits[Math.floor(Math.random() * digits.length)],
      "#",
    ];
    // Fill phần còn lại bằng a-z A-Z 0-9, không trùng ký tự trước
    while (arr.length < length) {
      const ch = all[Math.floor(Math.random() * all.length)];
      if (ch !== arr[arr.length - 1]) arr.push(ch);
    }
    // Shuffle (Fisher-Yates)
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    // Check không có consecutive duplicates sau shuffle
    let ok = true;
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === arr[i - 1]) {
        ok = false;
        break;
      }
    }
    if (ok) return arr.join("");
  }
  return Array.from(
    { length },
    (_, i) =>
      all[(i * 7 + Math.floor(Math.random() * all.length)) % all.length],
  ).join("");
}
const readline = require("readline");

const MAX_CAPTCHA_RETRIES = 7;

// CAPTCHA solver config — set từ runner qua initCapsolver()
let capsolverEnabled = false;
let capsolverApiKey = "";
let twoCaptchaEnabled = false;
let twoCaptchaApiKey = "";

function initCapsolver(config) {
  const cap = config?.CAPSOLVER || {};
  capsolverEnabled = cap.enabled === true;
  capsolverApiKey = cap.apiKey || "";
  if (capsolverEnabled && capsolverApiKey) {
    log.ok(`CapSolver ON (key: ${capsolverApiKey.slice(0, 8)}...)`);
  }

  const two = config?.TWO_CAPTCHA || {};
  twoCaptchaEnabled = two.enabled === true;
  twoCaptchaApiKey = two.apiKey || "";
  if (twoCaptchaEnabled && twoCaptchaApiKey) {
    log.ok(`2Captcha ON (key: ${twoCaptchaApiKey.slice(0, 8)}...)`);
  }

  if (!capsolverEnabled && !twoCaptchaEnabled) {
    log.warn("No CAPTCHA solver configured → manual mode");
  }
}

// ════════════════════════════════════════════════════════════════════
// CHECK MASKED EMAIL — verify k•••••@o•••••.eu matches working email
// So sánh ký tự đầu sau @ và sau . của masked email với working email
// ════════════════════════════════════════════════════════════════════
async function checkMaskedEmail(page, workingEmail) {
  try {
    const maskedEmail = await page
      .evaluate(() => {
        // Tìm trong <p class="description"> chứa <label class="semi-bold">
        const labels = document.querySelectorAll(
          "p.description label.semi-bold",
        );
        for (const l of labels) {
          const text = (l.textContent || "").trim();
          if (text.includes("@") && text.includes("•")) return text;
        }
        // Fallback: tìm bất kỳ label.semi-bold nào có masked email
        const allLabels = document.querySelectorAll("label.semi-bold");
        for (const l of allLabels) {
          const text = (l.textContent || "").trim();
          if (text.includes("@") && text.includes("•")) return text;
        }
        return null;
      })
      .catch(() => null);

    if (!maskedEmail) {
      log.warn(
        "Could not find masked email on Email Sent page — skipping check",
      );
      return { match: true, skipped: true };
    }

    log.info(`Masked email on page: ${maskedEmail}`);

    // Parse masked email: k•••••@o•••••.eu
    // Lấy ký tự đầu sau @ và ký tự đầu sau . cuối cùng
    const maskedAtIdx = maskedEmail.indexOf("@");
    const maskedLastDotIdx = maskedEmail.lastIndexOf(".");
    if (
      maskedAtIdx === -1 ||
      maskedLastDotIdx === -1 ||
      maskedLastDotIdx <= maskedAtIdx
    ) {
      log.warn(
        `Cannot parse masked email format: ${maskedEmail} — skipping check`,
      );
      return { match: true, skipped: true };
    }

    const maskedAfterAt = maskedEmail.charAt(maskedAtIdx + 1).toLowerCase();
    const maskedAfterDot = maskedEmail
      .charAt(maskedLastDotIdx + 1)
      .toLowerCase();

    // Parse working email
    const target = workingEmail.toLowerCase();
    const targetAtIdx = target.indexOf("@");
    const targetLastDotIdx = target.lastIndexOf(".");
    if (
      targetAtIdx === -1 ||
      targetLastDotIdx === -1 ||
      targetLastDotIdx <= targetAtIdx
    ) {
      log.warn(`Cannot parse working email: ${workingEmail} — skipping check`);
      return { match: true, skipped: true };
    }

    const targetAfterAt = target.charAt(targetAtIdx + 1);
    const targetAfterDot = target.charAt(targetLastDotIdx + 1);

    log.info(
      `Compare: after@ masked='${maskedAfterAt}' vs target='${targetAfterAt}' | after. masked='${maskedAfterDot}' vs target='${targetAfterDot}'`,
    );

    if (maskedAfterAt === targetAfterAt && maskedAfterDot === targetAfterDot) {
      log.ok(`Masked email matches working email ✓`);
      return { match: true };
    } else {
      log.err(`Masked email does NOT match! ${maskedEmail} vs ${workingEmail}`);
      return { match: false };
    }
  } catch (err) {
    log.warn(`checkMaskedEmail error: ${err.message} — skipping check`);
    return { match: true, skipped: true };
  }
}

// ════════════════════════════════════════════════════════════════════
// MANUAL INPUT
// ════════════════════════════════════════════════════════════════════
function askManual(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ════════════════════════════════════════════════════════════════════
// CAPSOLVER
// ════════════════════════════════════════════════════════════════════
async function solveCaptcha(base64Image) {
  const res = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: capsolverApiKey,
      task: {
        type: "ImageToTextTask",
        body: base64Image,
        websiteURL: "https://iforgot.apple.com",
        case: true,
        module: "common",
      },
    }),
  });
  const data = await res.json();
  if (data.errorId !== 0) {
    throw new Error(`CapSolver error: ${data.errorDescription}`);
  }
  if (data.solution?.text) return data.solution.text;

  const taskId = data.taskId;
  for (let i = 0; i < 20; i++) {
    await delay(3000);
    const r = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: capsolverApiKey, taskId }),
    });
    const rd = await r.json();
    if (rd.status === "ready") return rd.solution.text;
    if (rd.status === "failed")
      throw new Error(`CapSolver failed: ${rd.errorDescription}`);
  }
  throw new Error("CapSolver timeout");
}

// ════════════════════════════════════════════════════════════════════
// 2CAPTCHA
// ════════════════════════════════════════════════════════════════════
async function solveCaptcha2Captcha(base64Image) {
  // Step 1: submit image
  const formBody = new URLSearchParams({
    key: twoCaptchaApiKey,
    method: "base64",
    body: base64Image,
    json: "1",
  });

  const submitRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody.toString(),
  });
  const submitData = await submitRes.json();

  if (submitData.status !== 1) {
    throw new Error(`2Captcha submit error: ${submitData.request}`);
  }

  const taskId = submitData.request;
  log.info(`2Captcha task: ${taskId}`);

  // Step 2: poll for result
  for (let i = 0; i < 30; i++) {
    await delay(3000);
    const pollRes = await fetch(
      `https://2captcha.com/res.php?key=${twoCaptchaApiKey}&action=get&id=${taskId}&json=1`,
    );
    const pollData = await pollRes.json();

    if (pollData.status === 1) return pollData.request;
    if (pollData.request === "CAPCHA_NOT_READY") continue;

    throw new Error(`2Captcha failed: ${pollData.request}`);
  }
  throw new Error("2Captcha timeout");
}

// ════════════════════════════════════════════════════════════════════
// STEP 1: iforgot CAPTCHA → send reset email
// ════════════════════════════════════════════════════════════════════
async function submitAppleForgot(page, email) {
  log.divider(`Apple iForgot: ${email}`);

  // Load page với retry khi 503
  const IFORGOT_URL =
    "https://iforgot.apple.com/password/verify/appleid?language=US-EN";
  for (let loadAttempt = 1; loadAttempt <= 3; loadAttempt++) {
    try {
      await page.goto(IFORGOT_URL, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });
    } catch (navErr) {
      log.warn(
        `Page load error (attempt ${loadAttempt}/3): ${navErr.message.slice(0, 80)}`,
      );
      if (
        navErr.message.includes("timeout") ||
        navErr.message.includes("Timeout")
      ) {
        if (loadAttempt >= 3) {
          log.err("Navigation timeout after 3 attempts → need relaunch");
          return { ok: false, reason: "timeout_need_relaunch" };
        }
        // Clear cookies/cache rồi retry
        try {
          const client = await page.target().createCDPSession();
          await client.send("Network.clearBrowserCookies");
          await client.send("Network.clearBrowserCache");
        } catch {}
        await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
        await delay(5000);
        continue;
      }
      // Lỗi khác (net::ERR...) → cũng relaunch
      if (loadAttempt >= 3) {
        return { ok: false, reason: "nav_error_need_relaunch" };
      }
      await delay(5000);
      continue;
    }
    await delay(2000);

    const is503 = await page
      .evaluate(() => {
        const body = document.body?.innerText || "";
        return (
          body.includes("502") ||
          body.includes("503") ||
          body.includes("Service Temporarily Unavailable") ||
          body.includes("Service Unavailable") ||
          body.includes("Bad Gateway")
        );
      })
      .catch(() => false);

    if (!is503) break;

    log.warn(`503/502 Service Unavailable (attempt ${loadAttempt}/3)`);
    if (loadAttempt >= 2) {
      log.warn("Returning 503_need_relaunch → browser will be relaunched");
      return { ok: false, reason: "503_need_relaunch" };
    }
    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      await client.send("Network.clearBrowserCache");
    } catch {}
    await page.goto("about:blank", { timeout: 5000 }).catch(() => {});
    await delay(8000);
  }

  // Enter email
  log.info("Entering email...");
  let emailInput;
  try {
    emailInput = await page.waitForSelector("input.iforgot-apple-id", {
      timeout: 20000,
    });
  } catch (e) {
    log.warn(`Email input timeout: ${e.message} — signaling relaunch`);
    return { ok: false, reason: "timeout_need_relaunch" };
  }
  await emailInput.click();
  await delay(500);
  await page.evaluate((val) => {
    const inp = document.querySelector("input.iforgot-apple-id");
    if (inp) {
      inp.focus();
      inp.value = val;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
      inp.dispatchEvent(new Event("blur", { bubbles: true }));
    }
  }, email);
  await delay(1000);
  // Verify value
  const filledEmail = await page.evaluate(() => {
    const inp = document.querySelector("input.iforgot-apple-id");
    return inp ? inp.value : "";
  });
  log.info(`Email filled: "${filledEmail}"`);

  // CAPTCHA retry loop
  for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
    log.info(`[CAPTCHA attempt ${attempt}/${MAX_CAPTCHA_RETRIES}]`);

    // Nếu retry → reload toàn bộ page + nhập lại email
    if (attempt > 1) {
      log.info("Reloading page + re-entering email...");
      try {
        await page.goto(IFORGOT_URL, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
      } catch (navErr) {
        log.warn(`Reload timeout: ${navErr.message.slice(0, 60)}`);
        return { ok: false, reason: "timeout_need_relaunch" };
      }
      await delay(2000);

      // Check 503
      const is503 = await page
        .evaluate(() => {
          const body = document.body?.innerText || "";
          return (
            body.includes("503") ||
            body.includes("502") ||
            body.includes("Service Unavailable") ||
            body.includes("Bad Gateway")
          );
        })
        .catch(() => false);
      if (is503) {
        log.warn("503/502 on reload");
        return { ok: false, reason: "503_need_relaunch" };
      }

      // Nhập lại email
      const retryInput = await page
        .waitForSelector("input.iforgot-apple-id", { timeout: 10000 })
        .catch(() => null);
      if (!retryInput) {
        log.warn("Email input not found after reload");
        continue;
      }
      await retryInput.click();
      await delay(300);
      await page.evaluate((val) => {
        const inp = document.querySelector("input.iforgot-apple-id");
        if (inp) {
          inp.focus();
          inp.value = val;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true }));
        }
      }, email);
      await delay(1000);
    }

    // Wait for CAPTCHA image
    const captchaImg = await page
      .waitForSelector(
        "img[alt='Image challenge'], img[alt='Type the characters you see or hear']",
        { timeout: 10000 },
      )
      .catch(() => null);

    if (!captchaImg) {
      log.warn("CAPTCHA image not found");
      if (attempt >= MAX_CAPTCHA_RETRIES)
        return { ok: false, reason: "no_captcha_image" };
      continue;
    }
    await delay(1500);

    // Screenshot CAPTCHA — gửi ảnh gốc (chỉ scale 2x, giữ nguyên màu)
    const base64 = await page
      .evaluate(() => {
        const img = document.querySelector(
          "img[alt='Image challenge'], img[alt='Type the characters you see or hear']",
        );
        if (!img) return null;

        const canvas = document.createElement("canvas");
        const scale = 2;
        canvas.width = img.naturalWidth * scale;
        canvas.height = img.naturalHeight * scale;
        const ctx = canvas.getContext("2d");

        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        return canvas.toDataURL("image/png").split(",")[1];
      })
      .catch(() => null);

    if (!base64) {
      log.warn("Failed to capture CAPTCHA image");
      if (attempt >= MAX_CAPTCHA_RETRIES)
        return { ok: false, reason: "captcha_process_fail" };
      continue;
    }
    log.info(
      `CAPTCHA captured: ${base64.length} chars (2x scaled, original colors)`,
    );

    // Solve CAPTCHA
    let captchaText;

    if (capsolverEnabled || twoCaptchaEnabled) {
      // Auto mode — thử CapSolver trước, fail thì fallback 2Captcha
      let solved = false;

      // ── Try CapSolver ──
      if (capsolverEnabled && capsolverApiKey) {
        try {
          captchaText = await solveCaptcha(base64);
          solved = true;
          log.info("[CapSolver] solved");
        } catch (err) {
          log.warn(`CapSolver error: ${err.message}`);
          if (
            err.message.includes("invalid") ||
            err.message.includes("insufficient") ||
            err.message.includes("balance")
          ) {
            log.warn(
              "CapSolver key invalid/balance empty — disabling for this session",
            );
            capsolverEnabled = false;
          }
        }
      }

      // ── Fallback: 2Captcha ──
      if (!solved && twoCaptchaEnabled && twoCaptchaApiKey) {
        try {
          captchaText = await solveCaptcha2Captcha(base64);
          solved = true;
          log.info("[2Captcha] solved");
        } catch (err) {
          log.warn(`2Captcha error: ${err.message}`);
          if (
            err.message.includes("WRONG_USER_KEY") ||
            err.message.includes("KEY_DOES_NOT_EXIST") ||
            err.message.includes("ERROR_ZERO_BALANCE")
          ) {
            log.warn(
              "2Captcha key invalid/balance empty — disabling for this session",
            );
            twoCaptchaEnabled = false;
          }
        }
      }

      if (!solved) {
        if (!capsolverEnabled && !twoCaptchaEnabled) {
          log.err("All CAPTCHA solvers disabled — stopping");
          return { ok: false, reason: "all_solvers_fatal" };
        }
        if (attempt >= MAX_CAPTCHA_RETRIES)
          return { ok: false, reason: "captcha_solve_fail" };
        continue;
      }
    } else {
      // Manual mode — nhập tay
      captchaText = await askManual("⌨️  Nhập CAPTCHA: ");
      if (!captchaText) {
        if (attempt >= MAX_CAPTCHA_RETRIES)
          return { ok: false, reason: "manual_empty" };
        continue;
      }
    }
    log.ok(`CAPTCHA result: "${captchaText}"`);

    // Enter CAPTCHA
    const captchaInput = await page.waitForSelector("input.captcha-input", {
      timeout: 10000,
    });
    await captchaInput.click();
    await delay(300);
    await page.evaluate((val) => {
      const inp = document.querySelector("input.captcha-input");
      if (inp) {
        inp.focus();
        inp.value = val;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("blur", { bubbles: true }));
      }
    }, captchaText);
    await delay(500);
    log.info(`CAPTCHA filled: "${captchaText}"`);

    // Click Continue
    log.info("Clicking Continue...");
    await page.evaluate(() => {
      const btn = document.querySelector("button.button-primary.nav-action");
      if (btn) btn.click();
    });

    // Chờ page chuyển — poll tối đa 15s
    log.info("Waiting for page transition...");
    let transitioned = false;
    for (let w = 0; w < 15; w++) {
      await delay(1000);

      // Check h2.context-title hoặc span idms-step-title cho "locked" / "not valid"
      const h2Check = await page
        .evaluate(() => {
          const h2 = document.querySelector("h2.context-title");
          if (h2) {
            const text = h2.textContent.trim().toLowerCase();
            if (text.includes("locked")) return "locked";
            if (text.includes("not valid") || text.includes("not supported"))
              return "not_valid";
          }
          // Fallback: check span với idms-step-title
          const spans = document.querySelectorAll(
            "span[id*='idms-step-title']",
          );
          for (const s of spans) {
            const t = s.textContent.trim().toLowerCase();
            if (t.includes("locked")) return "locked";
            if (t.includes("not valid") || t.includes("not supported"))
              return "not_valid";
          }
          return null;
        })
        .catch(() => null);

      if (h2Check === "locked") {
        log.err("Account is locked (h2.context-title)");
        return { ok: false, reason: "account_locked" };
      }
      if (h2Check === "not_valid") {
        log.err("Account not valid (h2.context-title)");
        return { ok: false, reason: "account_not_valid" };
      }

      const stillCaptcha = await page
        .evaluate(() => {
          return !!document.querySelector("input.captcha-input");
        })
        .catch(() => false);

      if (!stillCaptcha) {
        transitioned = true;
        log.ok("Page transitioned from CAPTCHA");
        break;
      }

      // Check nếu có error message trong khi chờ
      const err = await page
        .evaluate(() => {
          const el = document.querySelector(".form-message");
          return el ? el.textContent.trim() : "";
        })
        .catch(() => "");

      if (
        err.includes("characters") ||
        err.includes("enter the characters") ||
        err.includes("Please type")
      ) {
        log.warn(`CAPTCHA wrong: "${err}" — will reload page`);
        break;
      }

      if (
        err.includes("could not be completed") ||
        err.includes("Try again later")
      ) {
        log.warn(`Server error: "${err}" — will reload page`);
        break;
      }

      if (err.includes("not valid") || err.includes("not supported")) {
        log.err(`Account not valid (form-message): "${err}"`);
        return { ok: false, reason: "account_not_valid" };
      }
    }

    if (!transitioned) {
      // Check body text cho "not valid" trước khi retry — tránh retry vô ích
      const bodyNotValid = await page
        .evaluate(() => document.body?.innerText || "")
        .catch(() => "");
      if (
        bodyNotValid.includes("not valid") ||
        bodyNotValid.includes("not supported")
      ) {
        log.err("Account not valid (detected from body during CAPTCHA)");
        return { ok: false, reason: "account_not_valid" };
      }
      // Vẫn còn trên trang CAPTCHA → CAPTCHA sai hoặc chưa chuyển
      if (attempt < MAX_CAPTCHA_RETRIES) continue;
      return { ok: false, reason: "captcha_wrong_or_stuck" };
    }

    // ── Page đã chuyển — detect trang mới ──
    await delay(2000); // chờ thêm cho page render xong

    // Helper: đọc subtitle hiện tại (check cả p.subtitle và span title)
    const getSubtitle = () =>
      page
        .evaluate(() => {
          const p = document.querySelector("p.subtitle");
          if (p && p.textContent.trim()) return p.textContent.trim();
          // Fallback: check span với class chứa "step-title"
          const span = document.querySelector(
            "span[class*='step-title'], span[id*='step-title']",
          );
          if (span && span.textContent.trim()) return span.textContent.trim();
          // Fallback: check h1
          const h1 = document.querySelector("h1");
          if (h1 && h1.textContent.trim()) return h1.textContent.trim();
          return "";
        })
        .catch(() => "");

    // Helper: click Continue/action button
    const clickContinue = () =>
      page.evaluate(() => {
        const btn =
          document.querySelector("button#action") ||
          document.querySelector("button.button-primary.nav-action") ||
          document.querySelector("button:not([disabled]).button-primary");
        if (btn) btn.click();
      });

    let subtitle = await getSubtitle();
    log.info(`Page subtitle: "${subtitle}"`);

    // Check "Apple Account is not valid or not supported" → fail ngay
    if (
      subtitle.toLowerCase().includes("not valid") ||
      subtitle.toLowerCase().includes("not supported")
    ) {
      log.err(`Account not valid: "${subtitle}"`);
      return { ok: false, reason: "account_not_valid" };
    }

    // Check "This account is locked" → fail ngay
    if (
      subtitle.toLowerCase().includes("account is locked") ||
      subtitle.toLowerCase().includes("locked")
    ) {
      log.err(`Account locked: "${subtitle}"`);
      return { ok: false, reason: "account_locked" };
    }

    // Check "Confirm your birthday" → fail ngay
    if (
      subtitle.toLowerCase().includes("confirm your birthday") ||
      subtitle.toLowerCase().includes("birthday")
    ) {
      log.err(`Birthday required: "${subtitle}"`);
      return { ok: false, reason: "birthday_required" };
    }

    // Check phone number required → fail ngay
    if (
      subtitle.toLowerCase().includes("phone number") ||
      subtitle.toLowerCase().includes("verify your identity") ||
      subtitle.toLowerCase().includes("trusted phone")
    ) {
      log.err(`Phone number required: "${subtitle}"`);
      return { ok: false, reason: "phone_number_required" };
    }

    // Check "Enter Recovery Key" → fail ngay
    if (subtitle.toLowerCase().includes("recovery key")) {
      log.err(`Recovery key required: "${subtitle}"`);
      return { ok: false, reason: "recovery_key_required" };
    }

    // Check "Select what information you want to reset" → bấm Continue
    if (
      subtitle.toLowerCase().includes("select what information") ||
      subtitle.toLowerCase().includes("what you want to reset")
    ) {
      log.ok("'Select what information' page → clicking Continue...");
      await delay(1000);
      await clickContinue();
      // Chờ chuyển sang trang tiếp
      for (let w = 0; w < 15; w++) {
        await delay(1000);
        subtitle = await getSubtitle();
        if (!subtitle.toLowerCase().includes("select what information")) break;
      }
      log.info(`After select info → subtitle: "${subtitle}"`);
    }

    // Check "Choose how to unlock" page
    const hasUnlock =
      subtitle.toLowerCase().includes("unlock") ||
      subtitle.toLowerCase().includes("choose") ||
      subtitle.toLowerCase().includes("how you want");

    if (hasUnlock) {
      log.ok("CAPTCHA correct → unlock method page");
      await delay(1000);

      // Helper: click chính xác bằng Puppeteer elementHandle.click() (isTrusted=true, auto scroll into view)
      const clickActionButton = async () => {
        const selectors = [
          "button#action",
          "button.button-primary.nav-action",
          "button.button-primary:not([disabled])",
        ];
        for (const sel of selectors) {
          try {
            const btn = await page.$(sel);
            if (btn) {
              await btn.click();
              log.info(`Clicked [${sel}] (elementHandle.click)`);
              return true;
            }
          } catch (e) {
            log.warn(
              `Click [${sel}] failed: ${e.message.slice(0, 60)} — trying next`,
            );
          }
        }
        // Fallback: tìm button chứa text "Continue"
        try {
          const allBtns = await page.$$("button");
          for (const b of allBtns) {
            const txt = await b
              .evaluate((el) => (el.textContent || "").trim().toLowerCase())
              .catch(() => "");
            if (txt.includes("continue")) {
              await b.click();
              log.info(`Clicked [text:continue] (elementHandle.click)`);
              return true;
            }
          }
        } catch (e) {
          log.warn(`Click [text:continue] failed: ${e.message.slice(0, 60)}`);
        }
        // Fallback cuối: focus button rồi Enter
        try {
          const focused = await page.evaluate(() => {
            const btn =
              document.querySelector("button#action") ||
              document.querySelector("button.button-primary:not([disabled])");
            if (btn) {
              btn.focus();
              return true;
            }
            return false;
          });
          if (focused) {
            await page.keyboard.press("Enter");
            log.info("Pressed Enter on focused button (fallback)");
            return true;
          }
        } catch (e) {
          log.warn(`Enter key fallback failed: ${e.message.slice(0, 60)}`);
        }
        return false;
      };

      // Chọn radio "Get an email" bằng Puppeteer click (isTrusted=true)
      let radioClicked = false;
      try {
        const radioLabels = await page.$$("label");
        for (const label of radioLabels) {
          const txt = await label
            .evaluate((el) => (el.textContent || "").toLowerCase())
            .catch(() => "");
          if (txt.includes("email") || txt.includes("e-mail")) {
            await label.click();
            radioClicked = true;
            log.info("Selected 'Get an email' radio (label click)");
            break;
          }
        }
      } catch (e) {
        log.warn(`Radio label click failed: ${e.message.slice(0, 60)}`);
      }
      if (!radioClicked) {
        // Fallback: click radio đầu tiên hoặc dùng JS click
        try {
          const clicked = await page.evaluate(() => {
            const radio = document.querySelector("input[type='radio']");
            if (radio) {
              radio.click();
              return true;
            }
            const label = document.querySelector("label");
            if (label) {
              label.click();
              return true;
            }
            return false;
          });
          if (clicked) log.info("Selected radio (JS evaluate fallback)");
        } catch (e) {
          log.warn(`Radio fallback also failed: ${e.message.slice(0, 60)}`);
        }
      }
      await delay(800);

      // Click Continue
      log.info("Clicking Continue on unlock page...");
      await clickActionButton();

      // Chờ trang "Email Sent" load — retry click Continue mỗi 3s, tối đa 5 lần click
      log.info("Waiting for Email Sent page...");
      let clickRetryCount = 0;
      const MAX_CLICK_RETRIES = 5;

      for (let w = 0; w < 30; w++) {
        await delay(1000);
        const sub = await page
          .evaluate(() => {
            const p = document.querySelector("p.subtitle");
            const body = document.body?.innerText || "";
            return (p ? p.textContent.trim() : "") + "|" + body.slice(0, 200);
          })
          .catch(() => "");

        if (
          sub.includes("Email Sent") ||
          sub.includes("email has been sent") ||
          sub.includes("An email has been sent")
        ) {
          log.ok("Reset email sent successfully");
          const maskedCheck = await checkMaskedEmail(page, email);
          if (!maskedCheck.match) {
            return { ok: false, reason: "wrong_linked_email" };
          }
          return { ok: true, emailVerified: !maskedCheck.skipped };
        }

        // Mỗi 3 giây, nếu vẫn trên unlock page → click lại Continue
        if (
          w > 0 &&
          w % 3 === 0 &&
          (sub.includes("unlock") || sub.includes("Select how"))
        ) {
          clickRetryCount++;
          if (clickRetryCount > MAX_CLICK_RETRIES) {
            log.err(
              `Still on unlock page after ${MAX_CLICK_RETRIES} click retries — giving up`,
            );
            break;
          }
          log.warn(
            `Still on unlock page — retry click #${clickRetryCount}/${MAX_CLICK_RETRIES}...`,
          );

          // Chọn lại radio trước mỗi lần click
          try {
            const retryLabels = await page.$$("label");
            for (const label of retryLabels) {
              const txt = await label
                .evaluate((el) => (el.textContent || "").toLowerCase())
                .catch(() => "");
              if (txt.includes("email") || txt.includes("e-mail")) {
                await label.click();
                break;
              }
            }
          } catch (e) {
            // Fallback JS click
            await page
              .evaluate(() => {
                const radio = document.querySelector("input[type='radio']");
                if (radio) radio.click();
              })
              .catch(() => {});
          }
          await delay(300);

          await clickActionButton();
        }
      }

      // Vẫn không thấy Email Sent → check body text lần cuối
      const bodyText = await page
        .evaluate(() => document.body.innerText)
        .catch(() => "");
      if (
        bodyText.includes("Email Sent") ||
        bodyText.includes("email has been sent") ||
        bodyText.includes("An email has been sent")
      ) {
        log.ok("Reset email sent successfully");
        const maskedCheck = await checkMaskedEmail(page, email);
        if (!maskedCheck.match) {
          return { ok: false, reason: "wrong_linked_email" };
        }
        return { ok: true, emailVerified: !maskedCheck.skipped };
      }

      // Vẫn trên unlock page → FAIL chứ không assume sent
      if (bodyText.includes("unlock") || bodyText.includes("Select how")) {
        log.err("Continue button click not working — stuck on unlock page");
        return { ok: false, reason: "unlock_click_failed_need_relaunch" };
      }

      // Trang khác → coi thử có phải sent không
      log.warn(
        "Unlock page detected but Email Sent not confirmed — checking page...",
      );
      const currentUrl = page.url();
      if (currentUrl.includes("verify") || currentUrl.includes("sent")) {
        log.ok("URL suggests email was sent");
        const maskedCheck = await checkMaskedEmail(page, email);
        if (!maskedCheck.match) {
          return { ok: false, reason: "wrong_linked_email" };
        }
        return { ok: true, emailVerified: !maskedCheck.skipped };
      }
      return { ok: false, reason: "email_sent_not_confirmed_need_relaunch" };
    }

    // Check "Email has been sent" trực tiếp (không qua unlock page)
    const pageText = await page
      .evaluate(() => {
        const p = document.querySelector("p.subtitle");
        return p ? p.textContent : "";
      })
      .catch(() => "");

    if (
      pageText.includes("Email Sent") ||
      pageText.includes("email has been sent") ||
      pageText.includes("Unlock")
    ) {
      log.ok("Reset email sent successfully");
      const maskedCheck = await checkMaskedEmail(page, email);
      if (!maskedCheck.match) {
        return { ok: false, reason: "wrong_linked_email" };
      }
      return { ok: true, emailVerified: !maskedCheck.skipped };
    }

    log.warn("Unknown page after clicking Continue");
    // Log actual page content for debugging
    const debugSubtitle = subtitle || "(no subtitle)";
    log.info(`Current subtitle: "${debugSubtitle}"`);

    // Check body text cho locked / not valid trước khi retry
    const bodyCheck = await page
      .evaluate(() => document.body?.innerText || "")
      .catch(() => "");
    if (
      bodyCheck.includes("account is locked") ||
      bodyCheck.includes("locked")
    ) {
      log.err("Account is locked (detected from body)");
      return { ok: false, reason: "account_locked" };
    }
    if (
      bodyCheck.includes("not valid") ||
      bodyCheck.includes("not supported")
    ) {
      log.err("Account not valid (detected from body)");
      return { ok: false, reason: "account_not_valid" };
    }

    if (attempt >= MAX_CAPTCHA_RETRIES) {
      return { ok: false, reason: "unknown_page" };
    }
  }

  return { ok: false, reason: "max_retries" };
}

async function refreshCaptcha(page) {
  try {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button, a"));
      for (const b of btns) {
        const txt = (b.textContent || "").trim().toLowerCase();
        if (
          txt.includes("new code") ||
          txt.includes("new captcha") ||
          txt.includes("refresh")
        ) {
          b.click();
          return true;
        }
      }
      return false;
    });
    if (clicked) log.info("Refreshed CAPTCHA");
  } catch {}
  await delay(2000);
}

// ════════════════════════════════════════════════════════════════════
// STEP 2: Open reset link → change password
// ════════════════════════════════════════════════════════════════════
async function resetPasswordFromLink(page, resetLink, targetEmail = null) {
  log.divider("Apple Reset Password");
  log.info(`Opening: ${resetLink.slice(0, 80)}...`);

  try {
    await page.goto(resetLink, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (navErr) {
    log.warn(`Reset link navigation error: ${navErr.message.slice(0, 60)}`);
    return { ok: false, reason: "timeout_need_relaunch" };
  }
  await delay(3000);

  // ── Verify email trên trang Apple ──
  // Case 1: <label class="medium">email@domain</label>
  // Case 2: <p class="description">Enter a new password for <label class="semi-bold">email@domain</label></p>
  if (targetEmail && typeof targetEmail === "string") {
    const target = targetEmail.toLowerCase();
    const pageEmail = await page
      .evaluate(() => {
        // Tìm label.medium
        const labelMedium = document.querySelector("label.medium");
        if (labelMedium) {
          const text = labelMedium.textContent.trim();
          if (text.includes("@")) return text.toLowerCase();
        }
        // Tìm label.semi-bold trong p.description
        const labelSemiBold = document.querySelector(
          "p.description label.semi-bold",
        );
        if (labelSemiBold) {
          const text = labelSemiBold.textContent.trim();
          if (text.includes("@")) return text.toLowerCase();
        }
        // Fallback: bất kỳ label nào chứa email
        const labels = document.querySelectorAll("label");
        for (const l of labels) {
          const text = l.textContent.trim();
          if (text.includes("@") && text.length < 100)
            return text.toLowerCase();
        }
        return null;
      })
      .catch(() => null);

    if (pageEmail) {
      if (pageEmail === target) {
        log.ok(`Apple verify OK: ${target}`);
      } else {
        log.err(
          `Apple email mismatch: page shows ${pageEmail}, expected ${target}`,
        );
        return { ok: false, reason: `apple_wrong_email: ${pageEmail}` };
      }
    } else {
      log.warn("Could not find email on Apple page — continuing anyway");
    }
  }

  // Detect current page
  const pageState = await page.evaluate(() => {
    const subtitle = document.querySelector("p.subtitle");
    const text = subtitle ? subtitle.textContent.trim() : "";
    if (text.includes("Enter Password")) return "enter_password";
    if (text.includes("New Apple") && text.includes("Password"))
      return "new_password";
    return "unknown:" + text.slice(0, 60);
  });

  log.info(`Page state: ${pageState}`);

  // CASE 1: "Enter Password" → click "Forgot password?"
  if (pageState === "enter_password") {
    log.info("Case 1: Enter Password → clicking Forgot password...");

    // Click thật bằng Puppeteer (isTrusted=true)
    const forgotBtn = await page
      .waitForSelector("button.forgot-pwd, .forgot-pwd, a.forgot-pwd", {
        timeout: 10000,
      })
      .catch(() => null);
    if (!forgotBtn) {
      // Fallback: tìm bằng text
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a"));
        for (const b of btns) {
          if (
            (b.textContent || "")
              .trim()
              .toLowerCase()
              .includes("forgot password")
          ) {
            b.click();
            return true;
          }
        }
        return false;
      });
      if (!clicked) return { ok: false, reason: "forgot_pwd_btn_not_found" };
      log.info("Clicked via text fallback");
    } else {
      await forgotBtn.click();
      log.ok("Clicked Forgot password button");
    }

    // Poll tối đa 20s chờ trang "New Apple Account Password"
    log.info("Waiting for New Password page...");
    let hasNewPwd = false;
    for (let w = 0; w < 20; w++) {
      await delay(1000);
      hasNewPwd = await page
        .evaluate(() => {
          const subtitle = document.querySelector("p.subtitle");
          return subtitle
            ? subtitle.textContent.includes("New Apple") ||
                subtitle.textContent.includes("New Password")
            : false;
        })
        .catch(() => false);
      if (hasNewPwd) break;
    }

    if (!hasNewPwd) {
      return { ok: false, reason: "new_password_page_not_appeared" };
    }
    log.ok("Navigated to New Password page");
  }
  // CASE 2: Directly "New Apple Account Password"
  else if (pageState === "new_password") {
    log.ok("Case 2: Direct New Password page");
  } else {
    log.warn(`Unknown page state: ${pageState}`);
    return { ok: false, reason: `unknown_page: ${pageState}` };
  }

  // ── Fill password + submit với retry nếu validation error ──
  const MAX_PW_RETRIES = 5;
  for (let pwAttempt = 1; pwAttempt <= MAX_PW_RETRIES; pwAttempt++) {
    const newPassword = generateRandomPassword(18);
    log.info(
      `[Attempt ${pwAttempt}/${MAX_PW_RETRIES}] Generated password: ${newPassword}`,
    );
    await delay(1000);

    // Clear & fill password field 1
    const pwd1 = await page
      .waitForSelector("input#password, input.pwd", { timeout: 10000 })
      .catch(() => null);
    if (!pwd1) return { ok: false, reason: "password_field_1_not_found" };
    await pwd1.click({ clickCount: 3 });
    await delay(200);
    await pwd1.type(newPassword, { delay: 50 });
    await delay(500);

    // Clear & fill password field 2 (confirm)
    const pwd2Selector = await page.evaluate(() => {
      const inputs = Array.from(
        document.querySelectorAll('input[type="password"]'),
      );
      if (inputs.length >= 2) {
        const second = inputs[1];
        return second.id ? `#${second.id}` : null;
      }
      return null;
    });

    if (pwd2Selector) {
      const pwd2 = await page.$(pwd2Selector);
      if (pwd2) {
        await pwd2.click({ clickCount: 3 });
        await delay(200);
        await pwd2.type(newPassword, { delay: 50 });
      }
    } else {
      const filled = await page.evaluate((pw) => {
        const inputs = Array.from(
          document.querySelectorAll('input[type="password"]'),
        );
        if (inputs.length >= 2) {
          const inp = inputs[1];
          inp.focus();
          inp.value = pw;
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        return false;
      }, newPassword);
      if (!filled) {
        return { ok: false, reason: "password_field_2_not_found" };
      }
    }

    await delay(1500);

    // Check validation errors TRƯỚC khi click submit
    const preErrors = await page
      .evaluate(() => {
        const msgs = Array.from(
          document.querySelectorAll(".errorMsg.show, .form-message"),
        );
        return msgs.map((m) => m.textContent.trim()).filter(Boolean);
      })
      .catch(() => []);

    if (preErrors.length > 0) {
      log.warn(`Validation errors before submit: ${preErrors.join(" | ")}`);
      // Nếu lỗi consecutive/weak/guessed → retry với pass mới
      if (pwAttempt < MAX_PW_RETRIES) {
        log.info("Retrying with a different password...");
        continue;
      }
    }

    // Click "Reset Password"
    log.info("Clicking Reset Password...");
    await page.evaluate(() => {
      const btn =
        document.querySelector("button#action") ||
        document.querySelector("button.button-primary:not([disabled])");
      if (btn) btn.click();
    });
    await delay(5000);

    // Check page đã thay đổi chưa (success hoặc error page)
    const pageResult = await page
      .evaluate(() => {
        const subtitle = document.querySelector("p.subtitle");
        const subtitleText = subtitle ? subtitle.textContent.trim() : "";
        const bodyText = document.body.innerText || "";

        // Success
        if (
          subtitleText.includes("Unlocked") ||
          subtitleText.includes("Password Changed") ||
          bodyText.includes("Unlocked") ||
          bodyText.includes("Password Changed")
        ) {
          return { success: true };
        }

        // Validation errors trên page (sau submit)
        const errors = Array.from(
          document.querySelectorAll(
            ".errorMsg.show, .form-message, .std-error .form-message",
          ),
        );
        const errorTexts = errors
          .map((m) => m.textContent.trim())
          .filter(Boolean);
        if (errorTexts.length > 0) {
          return { success: false, errors: errorTexts };
        }

        // Kiểm tra password mismatch
        if (bodyText.includes("do not match")) {
          return { success: false, errors: ["Passwords do not match"] };
        }

        return { success: false, errors: [] };
      })
      .catch(() => ({ success: false, errors: [] }));

    if (pageResult.success) {
      log.ok(`Password changed successfully! New: ${newPassword}`);
      return { ok: true, newPassword };
    }

    if (pageResult.errors.length > 0) {
      log.warn(`Post-submit errors: ${pageResult.errors.join(" | ")}`);
      if (pwAttempt < MAX_PW_RETRIES) {
        log.info("Retrying with a different password...");
        continue;
      }
    }

    // Retry click if button was disabled (page chưa thay đổi)
    log.warn("Success page not detected, retrying click...");
    await page.evaluate(() => {
      const btn = document.querySelector("button#action");
      if (btn) {
        btn.removeAttribute("disabled");
        btn.click();
      }
    });
    await delay(5000);

    const success2 = await page
      .evaluate(() => {
        const text = document.body.innerText || "";
        return text.includes("Unlocked") || text.includes("Password Changed");
      })
      .catch(() => false);

    if (success2) {
      log.ok(`Password changed successfully! New: ${newPassword}`);
      return { ok: true, newPassword };
    }

    // Nếu chưa success và còn retry → thử pass mới
    if (pwAttempt < MAX_PW_RETRIES) {
      log.warn("Not confirmed — trying new password...");
    }
  }

  return { ok: false, reason: "reset_not_confirmed_after_retries" };
}

module.exports = {
  initCapsolver,
  submitAppleForgot,
  resetPasswordFromLink,
  solveCaptcha,
  solveCaptcha2Captcha,
};
