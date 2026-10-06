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
//
// ── 关于「桥的地址从哪儿来」，两条路都得通 ──
//
//   ① 插件 spawn 我们：命令行带 `--bridge <json>`（正常路径）。
//   ② 用户自己双击启动：没有 `--bridge`，去读插件留下的**发现文件**
//      （`%TEMP%/crystal-vault-float.json`）。
//
// 第一条第一版只有 ①，于是双击启动是一扇连不上库的死窗。更糟的是它
// **占住单实例锁**，让插件那两条命令从此静默失效——「装了、好奇双击、
// 命令再也没反应」，这是最差的第一印象。所以 ② 必须实现。

import { app, BrowserWindow, ipcMain, screen, shell, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = __dirname;

/** 发现文件名，与 src/companion.js 里那个常量必须一致。 */
const DISCOVERY_FILE = "crystal-vault-float.json";

/** 从命令行里取 `--bridge <json>`。插件 spawn 我们的时候就是这么传的。 */
function readBridgeArg(argv) {
  const i = argv.indexOf("--bridge");
  if (i < 0 || !argv[i + 1]) return null;
  try {
    return JSON.parse(argv[i + 1]);
  } catch {
    return null;
  }
}

/**
 * 读插件留下的发现文件（用户自己双击启动时走这条）。
 *
 * ⚠️ **必须验新鲜度和 pid**：上个会话崩溃留下的那个文件会指着一个早就没了的端口，
 * 照着它连只会得到一句含糊的失败。宁可回 null（渲染进程会说「请从 Obsidian 里打开」），
 * 也不要拿一个死端口去撞。
 */
function readDiscovery() {
  try {
    const raw = readFileSync(join(tmpdir(), DISCOVERY_FILE), "utf8");
    const d = JSON.parse(raw);
    if (!d || !d.port || !d.token) return null;
    // 超过 12 小时当过期（Obsidian 那侧进程肯定换过了）
    const age = Date.now() - Date.parse(d.startedAt || 0);
    if (!Number.isFinite(age) || age > 12 * 3600 * 1000) return null;
    // pid 还活着吗。signal 0 只探测存在性，不真发信号。
    if (d.pid) {
      try {
        process.kill(d.pid, 0);
      } catch {
        return null;
      }
    }
    return { origin: "http://127.0.0.1:" + d.port, token: d.token, from: "discovery" };
  } catch {
    return null;
  }
}

/**
 * 命令行给的优先（它是这次请求的明确意图），没有才退回发现文件。
 * 发现文件那条只补 origin/token——cardsFolder 之类还是要插件那边给，
 * 所以插件写的发现文件里也该带（见 companion.js 的 writeDiscovery）。
 */
function resolveBridge(argv) {
  const fromArg = readBridgeArg(argv);
  if (fromArg) return fromArg;
  const disc = readDiscovery();
  if (!disc) return null;
  // 发现文件里也记了 cardsFolder 之类的补充信息，读回来拼上。
  try {
    const raw = JSON.parse(readFileSync(join(tmpdir(), DISCOVERY_FILE), "utf8"));
    return { ...raw, origin: disc.origin, token: disc.token };
  } catch {
    return disc;
  }
}

// ⚠️ 额外数据里**只放命令行那份**：第二个实例存在的唯一理由是"插件要求换一扇窗"，
// 而插件总是带 `--bridge`。用户双击时额外数据为空 → 第一个实例只把它拉到前台。
// 单人实例锁。**两个窗口 = 两个写者**，而卡片坐标那几个 flush 是无基线的防抖写。
const pendingBridge = readBridgeArg(process.argv);
const gotLock = app.requestSingleInstanceLock(pendingBridge ? { bridge: pendingBridge } : {});

if (!gotLock) {
  // 已经有一扇在跑了。**别自己再开一扇**——直接退，让第一个实例去处理
  // （它会收到 second-instance，见下面）。这便是「装了、好奇双击、
  // 命令再也没反应」那个坑的正解：不抢，而是把意图交过去。
  app.quit();
} else {
  main(pendingBridge || resolveBridge(process.argv));
}

function main(initialBridge) {
  // ⚠️ **这里曾经有一句 `app.on("window-all-closed", () => {})`，已经删掉。**
  //
  // 它当初是为了防「销毁旧窗 → 建新窗」那一瞬窗口数为零时应用自杀
  // （Electron 在非 macOS 上的默认行为）。但它造出了一个**严重得多**的毛病：
  // 用户点 ✕ 关掉悬浮窗之后，**进程不退**，变成一个没有窗口的隐形僵尸，
  // 而它**永久占着单实例锁**——于是插件那两条命令从此再也起不来，
  // 用户看到的只是"点了没反应"，除非去任务管理器杀进程或重启。
  // 2026-10-06 首版发出去当天，用户自己就撞上了这个（诊断日志里
  // 「伴侣退出了 code=0」连报两次）。
  //
  // 现在不需要它了：下面的 `createWindow` 是**先建新窗、再销毁旧窗**
  // （见那个函数最后一行），中间从不会出现零窗口。所以让默认行为生效——
  // **关掉窗就该退**，那既是用户期望的，也是不让锁泄漏的唯一办法。
  //
  // 于是 `window-all-closed` 不再被覆盖。

  let win = null;

  /**
   * 第二个实例来了：把那边的桥配置接过来，**重开一扇窗**。
   *
   * 为什么要重开而不是 reload：桥的地址是走 `webPreferences.additionalArguments`
   * 进渲染进程的，而那个在窗口创建时就定死了，改不了。所以只能重建。
   * 代价是窗口位置会回到上次保存的那个（每次 move/resize 都存），观感上无感。
   */
  app.on("second-instance", (_e, argv, _cwd, additionalData) => {
    const next = (additionalData && additionalData.bridge) || readBridgeArg(argv);
    if (!next) {
      // 用户只是又双击了一次图标：把已有的窗拉到前面，别重开。
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    createWindow(next);
  });

  async function createWindow(bridgeCfg) {
    const bounds = await loadBounds();
    const old = win;
    win = new BrowserWindow({
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
        additionalArguments: ["--float-cfg=" + JSON.stringify(bridgeCfg || {})],
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
        if (win && !win.isDestroyed()) saveBounds(win.getBounds());
      }, 400);
    };
    win.on("resize", rememberSoon);
    win.on("move", rememberSoon);

    win.loadFile(join(HERE, "index.html"));

    // 桥断了要让用户**看见**。守着 /health：连续失败就弹一句，而不是留一扇
    // 正在编辑僵尸文件的窗（README 风险清单第 3 条）。
    startWatchdog(win, bridgeCfg);

    if (old && !old.isDestroyed()) old.destroy();
  }

  // 把「这个壳能做的事」交给渲染进程。contextIsolation 开着，只能走 IPC。
  // 用 `win` 这个可变引用而不是闭包捕获某一扇具体的窗——换窗之后照样指得对。
  ipcMain.handle("float:minimize", () => win && win.minimize());
  ipcMain.handle("float:close", () => win && win.close());
  ipcMain.handle("float:pin", (_e, on) => {
    if (!win) return false;
    win.setAlwaysOnTop(!!on, on ? "floating" : undefined);
    return win.isAlwaysOnTop();
  });
  ipcMain.handle("float:openExternal", (_e, url) => {
    const u = String(url || "");
    if (!/^https?:/i.test(u)) return false;
    shell.openExternal(u);
    return true;
  });

  app.whenReady().then(() => createWindow(initialBridge));
}

// ── 窗口位置 ────────────────────────────────────────────────

function boundsFile() {
  return join(app.getPath("userData"), "window.json");
}

async function loadBounds() {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(boundsFile(), "utf8"));
  } catch {
    saved = null;
  }
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    const p = screen.getPrimaryDisplay().workArea;
    const w = Math.min(1000, p.width);
    const h = Math.min(720, p.height);
    return { width: w, height: h, x: Math.round(p.x + (p.width - w) / 2), y: Math.round(p.y + (p.height - h) / 2) };
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
    if (!win || win.isDestroyed()) return;
    try {
      const ctl = typeof AbortController === "function" ? new AbortController() : null;
      const t = setTimeout(() => ctl && ctl.abort(), 3000);
      const res = await fetch(String(cfg.origin).replace(/\/+$/, "") + "/health", ctl ? { signal: ctl.signal } : undefined);
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
