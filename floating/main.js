// 悬浮伴侣的 Electron 主进程。
//
// 它只管三件事，别的都不管：**开一扇置顶的窗、把桥的地址传进去、窗口位置记住**。
// 界面、数据、渲染全在渲染进程里（entry-floating.js → 核心），主进程不碰。
//
// ── 关于置顶，spike 量出来的三条 ──
//   1. `WS_EX_TOPMOST` 确实会被设上，能压过最大化的 Edge（spike/float/topmost-probe.mjs，
//      带对照组：top=false 时 Edge 赢、top=true 时本窗赢）。
//   2. `level` 用 'floating' 和 'screen-saver' **没有区别**，所以用 'floating'。
//      ⚠️ 别拿 `win.isAlwaysOnTop()` 当证据——它在两档下都返回 true，分辨不了。
//   3. **有一个没查出原因的偶发**：首次跑那一轮三组全判「没压住」，之后 6 次连过、
//      精确复现也不重现。所以这里构造时设、show() 之后再重申一次，并且留一颗
//      「重新置顶」按钮——代价极小，而那次偶发是真的发生过。

import { app, BrowserWindow, ipcMain, screen, shell, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// ⚠️ 用 `__dirname` 而**不是** `fileURLToPath(import.meta.url)`。
//
// 这个文件只以 **CJS** 形态存在（esbuild 打给 Electron 的 `dist/floating/main.cjs`），
// 而 `import.meta` 在 CJS 输出里是**空的**——esbuild 会警告
// `"import.meta" is not available with the "cjs" output format and will be empty`，
// 而它算出来的 HERE 是错的，后果是 preload.cjs 和 index.html 都找不到。
// 这种错**不报错、只是白屏**，所以在这里一次说清楚。
const HERE = __dirname;

/** 从命令行里取 --bridge <json>。插件 spawn 我们的时候就是这么传的。 */
function readBridgeArg(argv) {
  const i = argv.indexOf("--bridge");
  if (i < 0 || !argv[i + 1]) return null;
  try {
    return JSON.parse(argv[i + 1]);
  } catch {
    return null;
  }
}

const bridge = readBridgeArg(process.argv) || null;

// 单人实例。**两个窗口 = 两个写者**，而卡片坐标那几个 flush 是无基线的防抖写
// （见 README 的风险清单）。第二实例起来就把第一扇窗拉出来。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  // ⚠️ 必须挡掉：下面「destroy 旧窗 → 建新窗」之类的空档里窗口数为零时，
  // 非 macOS 的默认行为是**直接退应用**（spike 里就被这一条坑过一次：
  // 退出码还是 0，看着像跑完了）。
  app.on("window-all-closed", () => {});

  app.on("second-instance", () => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(async () => {
    const bounds = await loadBounds();
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 420,
      minHeight: 320,
      frame: false, // 无边框；拖拽走 chrome 条上的 -webkit-app-region
      resizable: true,
      alwaysOnTop: true, // ① 构造时设
      skipTaskbar: false, // 保留任务栏条目：用户要的是压过普通窗口，不是隐形
      show: false, // ready-to-show 再显示，避免白闪
      backgroundColor: "#0e1a29", // 对齐阅读器渐变起始色
      webPreferences: {
        preload: join(HERE, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // preload 要用 contextBridge + 读 process.argv
        // 桥的地址从这里进渲染进程（见 preload.js）。走命令行而不是写在文件里：
        // 端口每次启动都不一样，没有可缓存的东西。
        additionalArguments: ["--float-cfg=" + JSON.stringify(bridge || {})],
      },
    });

    win.once("ready-to-show", () => {
      win.show();
      // ② show() 之后再重申一次 —— 应对那次没查出原因的偶发（见文件头第 3 条）。
      win.setAlwaysOnTop(true, "floating");
    });

    // 窗口位置**存在伴侣自己的 userData 里**，绝不进 Obsidian 的 data.json——
    // 那个跟着 vault 走，笔记本上的坐标会被套到台式机的显示器布局上。
    let saveTimer = null;
    const rememberSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) saveBounds(win.getBounds());
      }, 400);
    };
    win.on("resize", rememberSoon);
    win.on("move", rememberSoon);

    win.loadFile(join(HERE, "index.html"));

    // 把「这个壳能做的事」交给渲染进程。contextIsolation 开着，只能走 IPC。
    ipcMain.handle("float:minimize", () => win.minimize());
    ipcMain.handle("float:close", () => win.close());
    ipcMain.handle("float:pin", (_e, on) => {
      win.setAlwaysOnTop(!!on, on ? "floating" : undefined);
      return win.isAlwaysOnTop();
    });
    ipcMain.handle("float:openExternal", (_e, url) => {
      const u = String(url || "");
      if (!/^https?:/i.test(u)) return false;
      shell.openExternal(u);
      return true;
    });

    // 桥断了要让用户**看见**。守着 /health：连续失败就弹一句，而不是留一扇
    // 正在编辑僵尸文件的窗（README 风险清单第 3 条）。
    startWatchdog(win, bridge);
  });
}

// ── 窗口位置 ────────────────────────────────────────────────

function boundsFile() {
  return join(app.getPath("userData"), "window.json");
}

async function loadBounds() {
  const fallback = { width: 1000, height: 720 };
  let saved = null;
  try {
    saved = JSON.parse(await readFile(boundsFile(), "utf8"));
  } catch {
    saved = null;
  }
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    const p = screen.getPrimaryDisplay().workArea;
    return {
      width: Math.min(1000, p.width),
      height: Math.min(720, p.height),
      x: Math.round(p.x + (p.width - Math.min(1000, p.width)) / 2),
      y: Math.round(p.y + (p.height - Math.min(720, p.height)) / 2),
    };
  }
  // ⚠️ 夹回可见区域：拔掉副屏之后，上次那份坐标会把窗开到屏幕外，
  // 而用户唯一的补救办法是去删一个 JSON 文件。尺寸留着，位置丢掉重新居中。
  const ds = screen.getAllDisplays();
  const hit = ds.some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width && saved.x + saved.width > a.x && saved.y < a.y + a.height && saved.y + saved.height > a.y;
  });
  if (hit) return saved;
  const p = screen.getPrimaryDisplay().workArea;
  const w = Math.min(saved.width, p.width);
  const h = Math.min(saved.height, p.height);
  return { width: w, height: h, x: Math.round(p.x + (p.width - w) / 2), y: Math.round(p.y + (p.height - h) / 2) };
}

async function saveBounds(b) {
  try {
    await mkdir(dirname(boundsFile()), { recursive: true });
    await writeFile(boundsFile(), JSON.stringify(b), "utf8");
  } catch {
    /* 记不住位置不该影响用 */
  }
}

// ── 看门狗 ──────────────────────────────────────────────────

function startWatchdog(win, cfg) {
  if (!cfg || !cfg.origin) return;
  let strikes = 0;
  let told = false;
  const tick = async () => {
    if (win.isDestroyed()) return;
    try {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t = setTimeout(() => ctl && ctl.abort(), 3000);
      const res = await fetch(cfg.origin.replace(/\/+$/, "") + "/health", ctl ? { signal: ctl.signal } : undefined);
      clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      strikes = 0;
    } catch {
      strikes++;
      // 连续 3 次（约 6 秒）才算断——一次网络抖动不该弹窗。
      if (strikes >= 3 && !told) {
        told = true;
        dialog.showMessageBox(win, {
          type: "warning",
          title: "与 Obsidian 的连接断了",
          message: "晶体库那边不再回应。",
          detail:
            "这扇窗里**没有保存的改动不会再被写回**——为避免用旧内容覆盖新内容，" +
            "断线后不再自动写盘。\n\n请回到 Obsidian 检查它是否还在运行，然后重开这个窗口。",
          buttons: ["知道了"],
        });
      }
    }
  };
  const h = setInterval(tick, 2000);
  win.on("closed", () => clearInterval(h));
}
