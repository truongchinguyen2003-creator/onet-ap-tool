"use strict";

// ════════════════════════════════════════════════════════════════
// resize-windows.js — Chỉnh position + size cho 4 luồng trên màn 2K
// Chỉ sửa BROWSER config, KHÔNG tạo file mới
//
// Cách dùng: node resize-windows.js
// Muốn chỉnh → sửa SCREEN_WIDTH, SCREEN_HEIGHT, TASKBAR_HEIGHT bên dưới
// ════════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

// ── Cấu hình màn hình ──
const SCREEN_WIDTH = 2560;
const SCREEN_HEIGHT = 1440;
const TASKBAR_HEIGHT = 40; // thanh taskbar Windows

// ── Tính toán ──
const usableHeight = SCREEN_HEIGHT - TASKBAR_HEIGHT; // 1400
const COLS = 2;
const ROWS = 2;

const colWidth = Math.floor(SCREEN_WIDTH / COLS); // 1280
const rowHeight = Math.floor(usableHeight / ROWS); // 700

// Mỗi ô 1280px chia cho Onet + Apple
const ONET_WIDTH = 680;
const APPLE_WIDTH = colWidth - ONET_WIDTH; // 600

const layouts = [
  { instance: 1, col: 0, row: 0 }, // top-left
  { instance: 2, col: 0, row: 1 }, // bottom-left
  { instance: 3, col: 1, row: 0 }, // top-right
  { instance: 4, col: 1, row: 1 }, // bottom-right
];

console.log(
  `\n  Screen: ${SCREEN_WIDTH}x${SCREEN_HEIGHT} (usable height: ${usableHeight})`,
);
console.log(`  Grid: ${COLS}x${ROWS} | Cell: ${colWidth}x${rowHeight}`);
console.log(
  `  Onet: ${ONET_WIDTH}x${rowHeight} | Apple: ${APPLE_WIDTH}x${rowHeight}\n`,
);

for (const layout of layouts) {
  const configFile = path.join(
    __dirname,
    "config",
    `config${layout.instance}.js`,
  );

  if (!fs.existsSync(configFile)) {
    console.log(`  ⚠️  config${layout.instance}.js not found — skipping`);
    continue;
  }

  let content = fs.readFileSync(configFile, "utf-8");

  const onetX = layout.col * colWidth;
  const onetY = layout.row * rowHeight;
  const appleX = onetX + ONET_WIDTH;
  const appleY = onetY;

  const onetSize = `${ONET_WIDTH},${rowHeight}`;
  const appleSize = `${APPLE_WIDTH},${rowHeight}`;
  const onetPos = `${onetX},${onetY}`;
  const applePos = `${appleX},${appleY}`;

  // Replace ONET_WINDOW
  content = content.replace(
    /ONET_WINDOW:\s*\{[^}]+\}/,
    `ONET_WINDOW: { size: "${onetSize}", position: "${onetPos}" }`,
  );

  // Replace APPLE_WINDOW
  content = content.replace(
    /APPLE_WINDOW:\s*\{[^}]+\}/,
    `APPLE_WINDOW: { size: "${appleSize}", position: "${applePos}" }`,
  );

  // Replace WINDOW_SIZE
  content = content.replace(
    /WINDOW_SIZE:\s*"[^"]+"/,
    `WINDOW_SIZE: "${APPLE_WIDTH},${rowHeight}"`,
  );

  fs.writeFileSync(configFile, content, "utf-8");

  console.log(
    `  ✅ config${layout.instance}.js — Onet ${onetSize} @ ${onetPos} | Apple ${appleSize} @ ${applePos}`,
  );
}

console.log("\n  Done! Chỉ sửa BROWSER, không đụng proxy/path/timing.\n");
