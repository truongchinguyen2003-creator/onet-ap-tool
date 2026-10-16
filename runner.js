"use strict";

// ════════════════════════════════════════════════════════════════════
// runner.js — Main orchestration for apple-onet-tool
//
// Flow per main account (onet.pl):
// 1. Login onet.pl
// 2. Delete existing aliases
// 3. Batch 1: add 3 aliases (skip 409, keep trying pool) → process
// 4. Delete all aliases
// 5. Batch 2: add 2 aliases → process
// 6. Delete all aliases → mark main done → next
// Total: 5 alias adds per main account (onet limit)
// ════════════════════════════════════════════════════════════════════

const { delay, log } = require("./utils");
const {
  launchBrowser,
  authenticateProxy,
  safeClose,
  checkBrowserIP,
} = require("./browser");
const {
  loginOnet,
  addAliasBatch,
  deleteAllAliases,
  getAppleResetLink,
  MAX_ALIAS_FIRST_BATCH,
  MAX_ALIAS_SECOND_BATCH,
} = require("./onet");
const {
  initCapsolver,
  submitAppleForgot,
  resetPasswordFromLink,
} = require("./apple-forgot");
const { createFileIO } = require("./file-io");

const MAX_APPLE_RELAUNCH = 3;

// ════════════════════════════════════════════════════════════════════
// Helper: safe file write — catch ENOSPC to prevent crash & data loss
// ════════════════════════════════════════════════════════════════════
async function safeFileOp(fn, label) {
  try {
    await fn();
  } catch (e) {
    if (e.code === "ENOSPC") {
      log.err(`[ENOSPC] Disk full — cannot ${label}. Skipping write.`);
      return false;
    }
    throw e;
  }
  return true;
}

// ════════════════════════════════════════════════════════════════════
// Helper: relaunch Apple browser
// ════════════════════════════════════════════════════════════════════
async function relaunchApple(oldBrowser, config, proxyApple) {
  await safeClose(oldBrowser, "Apple");
  await delay(3000);

  const newBrowser = await launchBrowser(
    config,
    !!proxyApple,
    proxyApple,
    config.BROWSER.APPLE_WINDOW,
  );
  const newPage = (await newBrowser.pages())[0];
  if (proxyApple) {
    await authenticateProxy(newPage, proxyApple);
    await checkBrowserIP(newPage, "Apple");
  }
  return { browser: newBrowser, page: newPage };
}

// ════════════════════════════════════════════════════════════════════
// Helper: relaunch Onet browser (khi proxy 403)
// ════════════════════════════════════════════════════════════════════
async function relaunchOnet(oldBrowser, config, proxyOnet, mainAccount) {
  await safeClose(oldBrowser, "Onet");
  await delay(3000);

  const newBrowser = await launchBrowser(
    config,
    !!proxyOnet,
    proxyOnet,
    config.BROWSER.ONET_WINDOW,
  );
  const newPage = (await newBrowser.pages())[0];
  if (proxyOnet) {
    await authenticateProxy(newPage, proxyOnet);
    await checkBrowserIP(newPage, "Onet");
  }

  // Re-login onet
  const loginResult = await loginOnet(
    newPage,
    mainAccount.email,
    mainAccount.password,
  );
  if (!loginResult.ok) {
    throw new Error(`Re-login failed after relaunch: ${loginResult.reason}`);
  }

  return { browser: newBrowser, page: newPage };
}

// ════════════════════════════════════════════════════════════════════
// Process successfully added aliases
// ════════════════════════════════════════════════════════════════════
async function processAddedAliases(
  onetPage,
  appleState,
  addedEmails,
  fileIO,
  config,
  proxyApple,
) {
  // Ghi TẤT CẢ alias đã add vào pending TRƯỚC khi process
  // Nếu crash, restart sẽ biết tất cả email nào đang dở
  for (const email of addedEmails) {
    await safeFileOp(() => fileIO.writePending(email), `writePending ${email}`);
  }
  log.info(`Pending: ${addedEmails.length} email(s) tracked`);

  for (let i = 0; i < addedEmails.length; i++) {
    const workingEmail = addedEmails[i];

    log.divider(`ALIAS ${i + 1}/${addedEmails.length}: ${workingEmail}`);

    // ── Submit Apple iForgot + Read reset email ──
    // Có tối đa 2 lần forgot (nếu masked email match nhưng ko tìm thấy mail)
    const MAX_FORGOT_ATTEMPTS = 2;
    let linkResult = null;
    let forgotFailed = false;
    let forgotReason = "";

    for (
      let forgotAttempt = 1;
      forgotAttempt <= MAX_FORGOT_ATTEMPTS;
      forgotAttempt++
    ) {
      if (forgotAttempt > 1) {
        log.warn(
          `Retry forgot flow (attempt ${forgotAttempt}/${MAX_FORGOT_ATTEMPTS}) — mail not found but masked email matched`,
        );
      }

      // ── Submit Apple iForgot (with relaunch retry) ──
      let forgotOk = false;
      forgotReason = "";

      for (let relaunch = 0; relaunch <= MAX_APPLE_RELAUNCH; relaunch++) {
        if (relaunch > 0) {
          log.warn(
            `Relaunching Apple browser (attempt ${relaunch}/${MAX_APPLE_RELAUNCH})...`,
          );
          try {
            const newState = await relaunchApple(
              appleState.browser,
              config,
              proxyApple,
            );
            appleState.browser = newState.browser;
            appleState.page = newState.page;
          } catch (e) {
            log.err(`Relaunch failed: ${e.message}`);
            continue;
          }
        }

        const forgotResult = await submitAppleForgot(
          appleState.page,
          workingEmail,
        );

        if (forgotResult.ok) {
          forgotOk = true;
          break;
        }

        forgotReason = forgotResult.reason || "unknown";

        // wrong_linked_email → fail ngay, không retry
        if (forgotReason === "wrong_linked_email") {
          log.err(`Masked email does not match — linked alias fail`);
          break;
        }

        if (forgotReason.includes("need_relaunch")) {
          log.warn(`Apple needs relaunch: ${forgotReason}`);
          continue;
        }

        // Lỗi khác → không retry
        break;
      }

      if (!forgotOk) {
        forgotFailed = true;
        break;
      }

      // ── Read reset email (Powiadomienia + Spam) ──
      await delay(config.TIMING.EMAIL_WAIT_RETRY_DELAY || 5000);

      linkResult = await getAppleResetLink(
        onetPage,
        workingEmail,
        config.TIMING.EMAIL_WAIT_MAX_RETRIES || 10,
        config.TIMING.EMAIL_WAIT_RETRY_DELAY || 5000,
      );

      if (linkResult.ok) {
        break; // Tìm thấy link → thoát vòng forgot
      }

      // Không tìm thấy mail → nếu còn lần forgot thì thử lại
      if (forgotAttempt < MAX_FORGOT_ATTEMPTS) {
        log.warn(`No reset email found — will retry forgot flow...`);
        continue;
      }

      // Hết lần forgot → fail
      log.err(
        `No reset link after ${MAX_FORGOT_ATTEMPTS} forgot attempts: ${linkResult.reason}`,
      );
    }

    if (forgotFailed) {
      await safeFileOp(
        () => fileIO.writeFailed(workingEmail, forgotReason),
        `writeFailed ${workingEmail}`,
      );
      await safeFileOp(
        () => fileIO.removeFromPool(workingEmail),
        `removeFromPool ${workingEmail}`,
      );
      await safeFileOp(
        () => fileIO.removeFromPending(workingEmail),
        `removeFromPending ${workingEmail}`,
      );
      continue;
    }

    if (!linkResult || !linkResult.ok) {
      await safeFileOp(
        () =>
          fileIO.writeFailed(
            workingEmail,
            `no_reset_link: ${linkResult?.reason || "unknown"}`,
          ),
        `writeFailed ${workingEmail}`,
      );
      await safeFileOp(
        () => fileIO.removeFromPool(workingEmail),
        `removeFromPool ${workingEmail}`,
      );
      await safeFileOp(
        () => fileIO.removeFromPending(workingEmail),
        `removeFromPending ${workingEmail}`,
      );
      continue;
    }

    // ── Reset password (with relaunch retry) ──
    let resetOk = false;
    let resetPassword = "";
    let resetReason = "";

    for (let relaunch = 0; relaunch <= MAX_APPLE_RELAUNCH; relaunch++) {
      if (relaunch > 0) {
        log.warn(
          `Relaunching Apple browser for reset (attempt ${relaunch}/${MAX_APPLE_RELAUNCH})...`,
        );
        try {
          const newState = await relaunchApple(
            appleState.browser,
            config,
            proxyApple,
          );
          appleState.browser = newState.browser;
          appleState.page = newState.page;
        } catch (e) {
          log.err(`Relaunch failed: ${e.message}`);
          continue;
        }
      }

      const resetResult = await resetPasswordFromLink(
        appleState.page,
        linkResult.resetLink,
        workingEmail,
      );

      if (resetResult.ok) {
        resetOk = true;
        resetPassword = resetResult.newPassword;
        break;
      }

      resetReason = resetResult.reason || "unknown";

      if (resetReason.includes("need_relaunch")) {
        log.warn(`Apple reset needs relaunch: ${resetReason}`);
        continue;
      }

      break;
    }

    if (resetOk) {
      await safeFileOp(
        () => fileIO.writeSuccess(workingEmail, resetPassword),
        `writeSuccess ${workingEmail}`,
      );
    } else {
      await safeFileOp(
        () => fileIO.writeFailed(workingEmail, resetReason),
        `writeFailed ${workingEmail}`,
      );
    }
    await safeFileOp(
      () => fileIO.removeFromPool(workingEmail),
      `removeFromPool ${workingEmail}`,
    );
    await safeFileOp(
      () => fileIO.removeFromPending(workingEmail),
      `removeFromPending ${workingEmail}`,
    );

    await delay(config.TIMING.DELAY_BETWEEN_ALIASES || 3000);
  }
}

// ════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ════════════════════════════════════════════════════════════════════
async function run(config) {
  log.divider("APPLE-ONET-TOOL START");

  initCapsolver(config);
  const fileIO = createFileIO(config);

  const mainAccounts = await fileIO.readMainAccounts();
  let workingEmails = await fileIO.readWorkingEmails();

  if (!mainAccounts.length) {
    log.err("No main accounts!");
    return;
  }
  if (!workingEmails.length) {
    log.err("No working emails!");
    return;
  }

  log.info(
    `Main accounts: ${mainAccounts.length} | Working emails: ${workingEmails.length}`,
  );

  const proxyOnet = config.PROXY_ONET?.enabled
    ? config.PROXY_ONET.address
    : null;
  const proxyApple = config.PROXY_APPLE?.enabled
    ? config.PROXY_APPLE.address
    : null;
  let onetBrowser = null;
  let appleState = { browser: null, page: null };

  try {
    for (let mi = 0; mi < mainAccounts.length; mi++) {
      const mainAccount = mainAccounts[mi];
      log.divider(
        `MAIN ACCOUNT ${mi + 1}/${mainAccounts.length}: ${mainAccount.email}`,
      );

      // ── Launch Onet browser ──
      onetBrowser = await launchBrowser(
        config,
        !!proxyOnet,
        proxyOnet,
        config.BROWSER.ONET_WINDOW,
      );
      let onetPage = (await onetBrowser.pages())[0];
      if (proxyOnet) {
        await authenticateProxy(onetPage, proxyOnet);
        await checkBrowserIP(onetPage, "Onet");
      }

      // ── Login onet.pl ──
      const loginResult = await loginOnet(
        onetPage,
        mainAccount.email,
        mainAccount.password,
      );
      if (!loginResult.ok) {
        // Invalid password → ghi file invalid, bỏ qua account này
        if (
          loginResult.reason &&
          loginResult.reason.toLowerCase().includes("invalid password")
        ) {
          await safeFileOp(
            () => fileIO.writeMainInvalid(mainAccount.raw),
            "writeMainInvalid",
          );
          // Chỉ xóa khỏi main-accounts, KHÔNG ghi vào done (đã ghi vào invalid rồi)
          await safeFileOp(
            () => fileIO.removeFromMainAccounts(mainAccount.raw),
            "removeFromMainAccounts",
          );
          await safeClose(onetBrowser, "Onet");
          onetBrowser = null;
          continue;
        }

        if (loginResult.reason === "ip_blocked_need_relaunch") {
          log.warn(
            "IP blocked on login — relaunching Onet browser with new proxy...",
          );
          try {
            const newOnet = await relaunchOnet(
              onetBrowser,
              config,
              proxyOnet,
              mainAccount,
            );
            onetBrowser = newOnet.browser;
            onetPage = newOnet.page;
            log.info("Relaunch OK — continuing with new IP");
          } catch (e) {
            log.err(`Relaunch failed: ${e.message}`);
            // Lỗi tạm thời → KHÔNG markMainDone, giữ account cho lần chạy sau
            log.warn(`Skipping ${mainAccount.email} — will retry next run`);
            await safeClose(onetBrowser, "Onet").catch(() => {});
            onetBrowser = null;
            continue;
          }
        } else {
          log.err(`Login failed: ${loginResult.reason}`);
          // Lỗi tạm thời → KHÔNG markMainDone, giữ account cho lần chạy sau
          log.warn(`Skipping ${mainAccount.email} — will retry next run`);
          await safeClose(onetBrowser, "Onet");
          onetBrowser = null;
          continue;
        }
      }

      // ── Launch Apple browser ──
      appleState.browser = await launchBrowser(
        config,
        !!proxyApple,
        proxyApple,
        config.BROWSER.APPLE_WINDOW,
      );
      appleState.page = (await appleState.browser.pages())[0];
      if (proxyApple) {
        await authenticateProxy(appleState.page, proxyApple);
        await checkBrowserIP(appleState.page, "Apple");
      }

      // ── Check pending emails from previous run → process them ──
      const pendingEmails = await fileIO.readPending();
      if (pendingEmails.length > 0) {
        log.warn(
          `Found ${pendingEmails.length} pending email(s) from previous run — resuming`,
        );
        for (const pe of pendingEmails) {
          await safeFileOp(
            () => fileIO.removeFromPending(pe),
            `removeFromPending ${pe}`,
          );
        }
        await processAddedAliases(
          onetPage,
          appleState,
          pendingEmails,
          fileIO,
          config,
          proxyApple,
        );

        // Xóa alias cũ sau khi process xong
        await deleteAllAliases(onetPage);
        await delay(2000);
      }

      // ── Delete existing aliases (nếu không có pending) ──
      if (pendingEmails.length === 0) {
        await deleteAllAliases(onetPage);
        await delay(2000);
      }

      // ══════════════════════════════════════════════════════════
      // BATCH 1: add 3 aliases (skip fails, keep trying pool)
      // ══════════════════════════════════════════════════════════
      let mainQuotaExhausted = false;
      workingEmails = await fileIO.readWorkingEmails();

      if (workingEmails.length > 0) {
        log.divider(
          `BATCH 1: target ${MAX_ALIAS_FIRST_BATCH} aliases (pool: ${workingEmails.length})`,
        );
        let batch1 = await addAliasBatch(
          onetPage,
          MAX_ALIAS_FIRST_BATCH,
          workingEmails,
        );

        // 403 proxy error → relaunch Onet browser rồi retry batch
        if (batch1.proxyError) {
          log.warn("Proxy 403 — relaunching Onet browser...");
          try {
            const newOnet = await relaunchOnet(
              onetBrowser,
              config,
              proxyOnet,
              mainAccount,
            );
            onetBrowser = newOnet.browser;
            onetPage = newOnet.page;

            // Xóa alias cũ đã add trước khi retry — tránh 409 conflict
            if (batch1.added.length > 0) {
              log.info(
                `Deleting ${batch1.added.length} aliases from previous attempt before retry...`,
              );
              await deleteAllAliases(onetPage);
              await delay(2000);
            }

            workingEmails = await fileIO.readWorkingEmails();
            batch1 = await addAliasBatch(
              onetPage,
              MAX_ALIAS_FIRST_BATCH,
              workingEmails,
            );
          } catch (e) {
            log.err(`Onet relaunch failed: ${e.message}`);
            mainQuotaExhausted = true;
          }
        }

        // 405 = mail chính hết quota → skip luôn
        if (batch1.quotaExhausted) {
          log.warn(
            `Main account ${mainAccount.email} quota exhausted (405) — skipping to next main`,
          );
          mainQuotaExhausted = true;
        }

        // Remove mail fail (409 conflict) khỏi pool — 405/406 đã được giữ lại bên onet.js
        // Ghi failed TRƯỚC, xóa pool SAU — nếu ENOSPC thì email vẫn còn trong pool
        for (const failedEmail of batch1.failed) {
          await safeFileOp(
            () => fileIO.writeFailed(failedEmail, "alias_add_failed"),
            `writeFailed ${failedEmail}`,
          );
          await safeFileOp(
            () => fileIO.removeFromPool(failedEmail),
            `removeFromPool ${failedEmail}`,
          );
        }

        // Process successfully added aliases
        if (batch1.added.length > 0) {
          await processAddedAliases(
            onetPage,
            appleState,
            batch1.added,
            fileIO,
            config,
            proxyApple,
          );
        } else if (!mainQuotaExhausted) {
          log.warn("No aliases added in batch 1");
        }

        // Delete all after batch 1
        await deleteAllAliases(onetPage);
        await delay(config.TIMING.DELAY_BETWEEN_BATCHES || 5000);
      }

      // ══════════════════════════════════════════════════════════
      // BATCH 2: add 2 more aliases (skip if quota exhausted)
      // ══════════════════════════════════════════════════════════
      if (!mainQuotaExhausted) {
        workingEmails = await fileIO.readWorkingEmails();

        if (workingEmails.length > 0) {
          log.divider(
            `BATCH 2: target ${MAX_ALIAS_SECOND_BATCH} aliases (pool: ${workingEmails.length})`,
          );
          let batch2 = await addAliasBatch(
            onetPage,
            MAX_ALIAS_SECOND_BATCH,
            workingEmails,
          );

          // 403 proxy error → relaunch Onet browser rồi retry batch
          if (batch2.proxyError) {
            log.warn("Proxy 403 — relaunching Onet browser...");
            try {
              const newOnet = await relaunchOnet(
                onetBrowser,
                config,
                proxyOnet,
                mainAccount,
              );
              onetBrowser = newOnet.browser;
              onetPage = newOnet.page;

              // Xóa alias cũ đã add trước khi retry — tránh 409 conflict
              if (batch2.added.length > 0) {
                log.info(
                  `Deleting ${batch2.added.length} aliases from previous attempt before retry...`,
                );
                await deleteAllAliases(onetPage);
                await delay(2000);
              }

              workingEmails = await fileIO.readWorkingEmails();
              batch2 = await addAliasBatch(
                onetPage,
                MAX_ALIAS_SECOND_BATCH,
                workingEmails,
              );
            } catch (e) {
              log.err(`Onet relaunch failed: ${e.message}`);
            }
          }

          // Remove failed emails (409 conflict) from pool — 405/406 đã được giữ lại bên onet.js
          // Ghi failed TRƯỚC, xóa pool SAU
          for (const failedEmail of batch2.failed) {
            await safeFileOp(
              () => fileIO.writeFailed(failedEmail, "alias_add_failed"),
              `writeFailed ${failedEmail}`,
            );
            await safeFileOp(
              () => fileIO.removeFromPool(failedEmail),
              `removeFromPool ${failedEmail}`,
            );
          }

          // Process
          if (batch2.added.length > 0) {
            await processAddedAliases(
              onetPage,
              appleState,
              batch2.added,
              fileIO,
              config,
              proxyApple,
            );
          } else {
            log.warn("No aliases added in batch 2");
          }

          // Delete all after batch 2
          await deleteAllAliases(onetPage);
          await delay(config.TIMING.DELAY_BETWEEN_BATCHES || 5000);
        }
      }

      // ── Done with this main account ──
      await safeFileOp(
        () => fileIO.markMainDone(mainAccount.raw),
        "markMainDone",
      );
      await safeClose(appleState.browser, "Apple");
      await safeClose(onetBrowser, "Onet");
      appleState = { browser: null, page: null };
      onetBrowser = null;

      workingEmails = await fileIO.readWorkingEmails();
      if (workingEmails.length === 0) {
        log.warn("Working email pool exhausted");
        break;
      }

      await delay(config.TIMING.DELAY_BETWEEN_MAIN_ACCOUNTS || 10000);
    }
  } catch (e) {
    log.err(`Runner fatal: ${e.message}`);
    console.error(e);
  } finally {
    await safeClose(appleState.browser, "Apple");
    await safeClose(onetBrowser, "Onet");
  }

  log.divider("APPLE-ONET-TOOL DONE");
}

module.exports = { run };
