"use strict";

const fs = require("fs").promises;
const path = require("path");
const readline = require("readline");

function ask(rl, question, defaultVal = "") {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) =>
      resolve(answer.trim() || defaultVal),
    );
  });
}

async function ensureFile(filePath, defaultContent = "") {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, defaultContent, "utf-8");
  }
}

async function getExistingInstances() {
  const configDir = path.join(__dirname, "config");
  try {
    const files = await fs.readdir(configDir);
    const nums = files
      .filter((f) => /^config\d+\.js$/.test(f))
      .map((f) => parseInt(f.match(/config(\d+)\.js/)[1]))
      .sort((a, b) => a - b);
    return nums;
  } catch {
    return [];
  }
}

async function run() {
  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   APPLE-ONET-TOOL — Add Instances (v3)      ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const existing = await getExistingInstances();
    if (existing.length > 0) {
      console.log(`  Luồng hiện có: ${existing.join(", ")}`);
    } else {
      console.log(`  Chưa có luồng nào.`);
    }

    const input = await ask(rl, "Tạo thêm bao nhiêu luồng?", "2");
    const count = parseInt(input) || 1;

    // Tìm số tiếp theo chưa tồn tại
    const newNums = [];
    let next = 1;
    for (let added = 0; added < count; ) {
      if (!existing.includes(next)) {
        newNums.push(next);
        added++;
      }
      next++;
    }

    console.log(
      `\n  → Sẽ tạo luồng: ${newNums.join(", ")} (không đụng luồng cũ)\n`,
    );

    // ── Hỏi proxy & captcha config dùng chung cho các luồng mới ──
    const proxyOnetAddr = await ask(
      rl,
      "Proxy Onet (address, bỏ trống = OFF)",
      "",
    );
    const proxyAppleAddr = await ask(
      rl,
      "Proxy Apple (address, bỏ trống = OFF)",
      "43.230.9.47:1000:xvasnthien02-region-PL:xsdsyshhsgg",
    );
    const capsolverKey = await ask(
      rl,
      "CapSolver API key (bỏ trống = OFF)",
      "CAP-1FF7B8AA38122C12E4A08F49F9586DDEF3CBF6D4CEB757E308F376891C8154B2",
    );
    const twoCaptchaKey = await ask(
      rl,
      "2Captcha API key (bỏ trống = OFF)",
      "",
    );

    console.log("");

    for (const i of newNums) {
      const dataDir = path.join(__dirname, "data", String(i));
      const configDir = path.join(__dirname, "config");

      await fs.mkdir(dataDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });

      // Data files
      await ensureFile(
        path.join(dataDir, `main-accounts${i}.txt`),
        "# email|password\n",
      );
      await ensureFile(
        path.join(dataDir, `working-emails${i}.txt`),
        "# one apple email per line\n",
      );
      await ensureFile(path.join(dataDir, `output-success${i}.txt`), "");
      await ensureFile(path.join(dataDir, `output-failed${i}.txt`), "");
      await ensureFile(path.join(dataDir, `main-accounts-done${i}.txt`), "");
      await ensureFile(path.join(dataDir, `pending${i}.txt`), "");

      // Window position: dời xuống theo instance number
      const yOffset = (i - 1) * 760;

      const proxyOnetEnabled = proxyOnetAddr ? "true" : "false";
      const proxyAppleEnabled = proxyAppleAddr ? "true" : "false";
      const capsolverEnabled = capsolverKey ? "true" : "false";
      const twoCaptchaEnabled = twoCaptchaKey ? "true" : "false";

      // Config file
      const configContent = `"use strict";

const path = require("path");
const BASE_DIR = path.join(__dirname, "..");

const config = {
  INSTANCE: ${i},

  PATHS: {
    MAIN_ACCOUNTS: path.join(BASE_DIR, "data", "${i}", "main-accounts${i}.txt"),
    MAIN_ACCOUNTS_DONE: path.join(BASE_DIR, "data", "${i}", "main-accounts-done${i}.txt"),
    WORKING_EMAILS: path.join(BASE_DIR, "data", "${i}", "working-emails${i}.txt"),
    OUTPUT_SUCCESS: path.join(BASE_DIR, "data", "${i}", "output-success${i}.txt"),
    OUTPUT_FAILED: path.join(BASE_DIR, "data", "${i}", "output-failed${i}.txt"),
    PENDING: path.join(BASE_DIR, "data", "${i}", "pending${i}.txt"),
  },

  BROWSER: {
    HEADLESS: false,
    WINDOW_SIZE: "640,720",
    ONET_WINDOW: { size: "0,760", position: "0,${yOffset}" },
    APPLE_WINDOW: { size: "920,0", position: "920,${yOffset}" },
  },

  PROXY_ONET: {
    enabled: ${proxyOnetEnabled},
    address: "${proxyOnetAddr || "host:port:user:pass"}",
  },
  PROXY_APPLE: {
    enabled: ${proxyAppleEnabled},
    address: "${proxyAppleAddr || "host:port:user:pass"}",
  },

  CAPSOLVER: {
    enabled: ${capsolverEnabled},
    apiKey: "${capsolverKey || ""}",
  },

  TWO_CAPTCHA: {
    enabled: ${twoCaptchaEnabled},
    apiKey: "${twoCaptchaKey || ""}",
  },

  TIMING: {
    DELAY_BETWEEN_ALIASES: 3000,
    DELAY_BETWEEN_BATCHES: 5000,
    DELAY_BETWEEN_MAIN_ACCOUNTS: 10000,
    EMAIL_WAIT_RETRY_DELAY: 5000,
    EMAIL_WAIT_MAX_RETRIES: 8,
  },
};

module.exports = config;
`;

      await fs.writeFile(
        path.join(configDir, `config${i}.js`),
        configContent,
        "utf-8",
      );

      // Main file
      const mainContent = `"use strict";

const config = require("./config/config${i}");
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

log.divider("APPLE-ONET-TOOL [Instance ${i}]");
log.info("Data folder: data/${i}/");
log.info("Proxy Onet: " + (config.PROXY_ONET.enabled ? config.PROXY_ONET.address.split(":").slice(0, 2).join(":") : "OFF"));
log.info("Proxy Apple: " + (config.PROXY_APPLE.enabled ? config.PROXY_APPLE.address.split(":").slice(0, 2).join(":") : "OFF"));
log.info("CapSolver: " + (config.CAPSOLVER.enabled ? "ON" : "OFF"));
log.info("Headless: " + config.BROWSER.HEADLESS);

run(config).catch((e) => {
  log.err("Fatal: " + e.message);
  console.error(e);
  process.exit(1);
});
`;

      await fs.writeFile(
        path.join(__dirname, `main${i}.js`),
        mainContent,
        "utf-8",
      );

      console.log(
        `  ✅ Luồng ${i}: config/config${i}.js + main${i}.js + data/${i}/`,
      );
    }

    console.log(`\n  ✅ Tạo xong ${newNums.length} luồng mới!`);
    console.log(
      `  Luồng cũ (${existing.join(", ") || "không có"}) — không bị đụng.\n`,
    );

    console.log(`  ── Chuẩn bị data cho luồng mới ──`);
    for (const i of newNums) {
      console.log(`  Luồng ${i}:`);
      console.log(
        `    - Main accounts: data/${i}/main-accounts${i}.txt (email|password)`,
      );
      console.log(
        `    - Working emails: data/${i}/working-emails${i}.txt (1/line)`,
      );
    }

    console.log(`\n  ── Chạy ──`);
    for (const i of newNums) {
      console.log(`  Luồng ${i}: node main${i}.js`);
    }
    console.log(`\n  Mỗi luồng 1 terminal.\n`);
  } finally {
    rl.close();
  }
}

run().catch(console.error);
