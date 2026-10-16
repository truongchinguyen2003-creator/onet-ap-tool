"use strict";

// ════════════════════════════════════════════════════════════════════
// browser.js — Puppeteer browser launcher + helpers
// ════════════════════════════════════════════════════════════════════

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { log } = require("./utils");

puppeteer.use(StealthPlugin());

// Adware domains to block
const BLOCKED_DOMAINS = ["html-load.com", "error-report.com"];

function isBlockedUrl(url) {
  return BLOCKED_DOMAINS.some((d) => url.includes(d));
}

/**
 * Setup adware blocking + dialog dismiss on a page
 */
async function setupPageProtection(page) {
  // Auto dismiss dialogs — Cancel ads dialog, Accept others (beforeunload etc.)
  page.on("dialog", async (dialog) => {
    const msg = dialog.message() || "";
    log.info(`Auto-dismiss dialog: "${msg.slice(0, 60)}"`);
    if (
      msg.toLowerCase().includes("allow ads") ||
      msg.toLowerCase().includes("adblock")
    ) {
      await dialog.dismiss(); // Cancel — tránh redirect sang trang quảng cáo
    } else {
      await dialog.accept();
    }
  });

  // Block adware requests
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (isBlockedUrl(req.url())) {
        req.abort();
      } else {
        req.continue();
      }
    });
  } catch {}

  // Detect adware redirects (recovery handled by caller's retry logic)
  page.on("framenavigated", async (frame) => {
    try {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (isBlockedUrl(url) || url.includes("chrome-error://")) {
        log.warn(`Adware redirect detected: ${url.slice(0, 60)}`);
      }
    } catch {}
  });
}

/**
 * Launch a Puppeteer browser
 * @param {object} config
 * @param {boolean} useProxy
 * @param {string|null} proxyAddress - host:port:user:pass
 * @param {object} windowOpts - { size: "w,h", position: "x,y" }
 */
async function launchBrowser(
  config,
  useProxy = false,
  proxyAddress = null,
  windowOpts = {},
) {
  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--disable-dev-shm-usage",
    // Tắt popup "Save password?" của Chrome
    "--disable-save-password-bubble",
    "--disable-features=PasswordManager",
    "--password-store=basic",
    // Block adware domains at DNS level
    "--host-resolver-rules=MAP html-load.com 0.0.0.0, MAP error-report.com 0.0.0.0, MAP *.html-load.com 0.0.0.0, MAP *.error-report.com 0.0.0.0",
  ];

  const size = windowOpts.size || config?.BROWSER?.WINDOW_SIZE || "640,720";
  const position =
    windowOpts.position || config?.BROWSER?.WINDOW_POSITION || "0,0";
  args.push(`--window-size=${size}`);
  args.push(`--window-position=${position}`);

  if (useProxy && proxyAddress) {
    const parts = proxyAddress.split(":");
    const proxyUrl = `http://${parts[0]}:${parts[1]}`;
    args.push(`--proxy-server=${proxyUrl}`);
  }

  const browser = await puppeteer.launch({
    headless: config?.BROWSER?.HEADLESS === true,
    args,
    defaultViewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Setup protection on new pages
  browser.on("targetcreated", async (target) => {
    try {
      const page = await target.page();
      if (page) {
        await setupPageProtection(page);
      }
    } catch {}
  });

  // Setup protection on initial page(s)
  const pages = await browser.pages();
  for (const p of pages) {
    await setupPageProtection(p);
  }

  return browser;
}

/**
 * Authenticate proxy on a page
 */
async function authenticateProxy(page, proxyAddress) {
  if (!proxyAddress) return;
  const parts = proxyAddress.split(":");
  if (parts.length === 4) {
    await page.authenticate({ username: parts[2], password: parts[3] });
  }
}

/**
 * Clear browser data (cookies, cache)
 */
async function clearBrowserData(page) {
  try {
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.send("Network.clearBrowserCache");
    await client.detach();
  } catch {}
}

/**
 * Safe close browser
 */
async function safeClose(browser, label) {
  if (!browser) return;
  try {
    await browser.close();
    log.info(`${label} closed`);
  } catch (e) {
    log.warn(`Close ${label} error: ${e.message}`);
  }
}

/**
 * Check IP + Region via ipinfo.io (runs in browser context → uses proxy)
 */
async function checkBrowserIP(page, label) {
  try {
    const ipData = await page.evaluate(async () => {
      const r = await fetch("https://ipinfo.io/json");
      return r.json();
    });
    log.proxy(
      `${label} IP: ${ipData.ip} | Region: ${ipData.region || ipData.country} | City: ${ipData.city || "N/A"}`,
    );
    return ipData;
  } catch (e) {
    log.warn(`${label} IP check failed: ${e.message}`);
    return null;
  }
}

module.exports = {
  launchBrowser,
  authenticateProxy,
  clearBrowserData,
  safeClose,
  checkBrowserIP,
};
