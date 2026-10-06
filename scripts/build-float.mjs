// 只构建**悬浮伴侣**那几样东西。
//
// 为什么从 build.mjs 里抽出来：伴侣有自己的仓（`crystal-vault-float`），
// 那边**只有这一个产物**——没有 vault 形态、没有插件形态。要是构建配置留在
// build.mjs 里，伴侣仓就得抄一份走，而两份构建配置迟早会漂，
// 漂的症状是"自己机器上好好的、发出去的那份少了个文件"。
// 抽成模块之后，两边**调的是同一个函数**。
//
// 产出（默认 `dist/floating/`）：
//   bundle.js      渲染进程（核心 + 远程适配层 + 本地 pdf.js）
//   main.cjs       主进程
//   preload.cjs    预加载
//   index.html / theme.css
//   styles.css     与插件那一份**同源**（都从 src/entry-styles.js 导出）
//   package.json   含 electron-builder 的配置
//
// ⚠️ 它**不打包**。出安装包是 scripts/pack-float.mjs 的事——
// 构建和打包分开，是因为前者每次改代码都要跑（秒级），后者几分钟。

import { build } from "esbuild";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {object} opts
 * @param {string} opts.root       仓库根（用来找 plugin/inline-pdf-worker.mjs 和 src/）
 * @param {string} [opts.outDir]   产物目录，默认 dist/floating
 */
export async function buildFloat({ root, outDir = "dist/floating" } = {}) {
  const { inlinePdfWorker } = await import("../plugin/inline-pdf-worker.mjs");

  mkdirSync(outDir, { recursive: true });

  // 渲染进程：复用核心。**边看边记的界面重构会自动流到这里**，不用改两遍
  // ——这正是当初把核心做成宿主无关的回报。
  await build({
    bundle: true,
    format: "iife",
    target: "es2020",
    platform: "browser",
    logLevel: "info",
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    assetNames: "fonts/[name]-[hash]",
    entryPoints: [join(root, "src/entry-floating.js")],
    outfile: join(outDir, "bundle.js"),
    globalName: "ARIFLOAT",
    minify: true,
    // pdf.js **本地打进来**。比在 Obsidian 里简单：那边两级 eval/blob 兜底
    // 只是为了把 2MB 塞进 markdown 笔记，伴侣没有那条约束。
    plugins: [inlinePdfWorker(root)],
    banner: { js: "/* ARI Crystal Vault 悬浮伴侣 - built from ari-crystal */" },
  });

  // 主进程与预加载：node 侧，electron 由宿主提供。
  for (const [entry, out] of [
    ["floating/main.js", "main.cjs"],
    ["floating/preload.js", "preload.cjs"],
  ]) {
    await build({
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      entryPoints: [join(root, entry)],
      outfile: join(outDir, out),
      minify: false, // 这两个文件是出问题时唯一能读的东西，留可读性
      external: ["electron"],
      logLevel: "warning",
    });
  }

  // styles.css 与插件那一份**同源**，两边不会各自漂一套样式。
  const { default: css } = await import("../src/entry-styles.js");
  writeFileSync(join(outDir, "styles.css"), css);

  for (const f of ["index.html", "theme.css", "package.json"]) {
    copyFileSync(join(root, "floating", f), join(outDir, f));
  }

  return outDir;
}

// 直接 `node scripts/build-float.mjs` 时也跑一次（伴侣仓里就是这么调的）。
if (import.meta.url === new URL(`file://${process.argv[1]?.replace(/\\/g, "/")}`).href) {
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  await buildFloat({ root });
}
