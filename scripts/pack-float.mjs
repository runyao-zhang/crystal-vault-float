// 把悬浮伴侣打成 Windows 安装包。
//
// 产物落在 `dist/float-dist/`：
//   · CrystalFloat-<版本>-x64.exe            —— NSIS 安装包（免管理员、可选目录）
//   · CrystalFloat-portable-<版本>.exe       —— 单文件自解压，给「我不装东西」的人
//
// ── 用 Node API 而不是 CLI ──
//
// `node_modules/.bin/electron-builder` 在 Windows 上是个 .cmd，从 Node 里 spawn
// 要 shell:true、还得处理引号；而 electron-builder 本来就把 `build()` 导出着。
// 直接用 API，少一层能出错的壳。
//
// ── 镜像 ──
//
// 这台机器上 v8 的直连只有 156 KB/s，而 npmmirror 的二进制镜像实测 12.5 MB/s
// （见记忆 electron-install-silent-failure）。所以**本地默认走镜像**；
// GitHub Actions 那边网络本来就通、走官方源更稳，所以 CI 上不动这两个变量。
//
// ⚠️ 先跑 `npm run build`：这个脚本**只打包**，不构建。

import { build, Platform, Arch } from "electron-builder";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = join(ROOT, "dist", "floating");
const OUT_DIR = join(ROOT, "dist", "float-dist");

if (!existsSync(APP_DIR)) {
  console.error(`✗ 没有 ${APP_DIR} —— 先跑 npm run build`);
  process.exit(1);
}
for (const need of ["main.cjs", "preload.cjs", "index.html", "bundle.js"]) {
  if (!existsSync(join(APP_DIR, need))) {
    console.error(`✗ ${APP_DIR} 里缺 ${need} —— 先跑 npm run build`);
    process.exit(1);
  }
}

if (!process.env.CI) {
  process.env.ELECTRON_MIRROR ||= "https://registry.npmmirror.com/-/binary/electron/";
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||= "https://registry.npmmirror.com/-/binary/electron-builder-binaries/";
  console.log("镜像：ELECTRON_MIRROR=" + process.env.ELECTRON_MIRROR);
  console.log("      ELECTRON_BUILDER_BINARIES_MIRROR=" + process.env.ELECTRON_BUILDER_BINARIES_MIRROR);
}

console.log("\n打包中（第一次会下一套 nsis / winCodeSign 工具，几十 MB）…\n");

try {
  await build({
    projectDir: APP_DIR,
    targets: Platform.WINDOWS.createTarget(["nsis", "portable"], Arch.x64),
    // 这个仓库不做自动发布——发布走 land-float + 单独那个仓的 Actions。
    publish: "never",
  });
} catch (e) {
  console.error("\n✗ 打包失败：", (e && e.message) || e);
  process.exit(1);
}

console.log("\n产物：");
try {
  for (const f of readdirSync(OUT_DIR)) {
    const p = join(OUT_DIR, f);
    if (!statSync(p).isFile()) continue;
    console.log(`   ${f}  (${(statSync(p).size / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`\n   目录：${OUT_DIR}`);
  console.log("   装完之后插件设置里那一格可以留空——它会自动找到");
  console.log("   %LOCALAPPDATA%\\Programs\\CrystalFloat\\CrystalFloat.exe");
} catch (e) {
  console.log("   （列不出来：" + ((e && e.message) || e) + "）");
}

// ⚠️ 提醒一句，因为它每次都要说：**没签名**。未签名的 exe 首次运行会撞
// Windows SmartScreen「保护了你的电脑」。那一个弹窗丢的买家比体积本身多。
console.log("\n⚠️ 这两个包都**没有代码签名**——买家首次运行会看到 SmartScreen 拦截。");
console.log("   README 里要放「更多信息 → 仍要运行」的截图，否则很多人到这一步就走了。");
