// 悬浮伴侣的 Electron 主进程。
//
// 只管三件事：**开窗、把桥的地址传进去、窗口位置记住**。
// 界面、数据、渲染全在渲染进程里（entry-floating.js → 核心），主进程不碰。
//
// ── 两扇窗，不是一个窗换档 ──
//
// 用户 2026-10-06 纠正过一次：他要的是**两个功能各自一扇窗**（边看边记一扇、
// 结构窗一扇，并排放），不是一扇窗切来切去。所以这里按 `role` 管两扇：
//   · `reader` —— 边看边记（阅读器 + 右边那条笔记栏）
//   · `story`  —— 结构窗
//
// 两扇窗**同属一个进程**：单实例锁仍然只有一把（配置交棒那套机制照旧），
// 而两扇窗各有各的位置、各有各的状态命名空间（见 entry-floating.js）。
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
// ── 桥的地址从哪儿来，两条路都得通 ──
//
//   ① 插件 spawn 我们：命令行带 `--bridge <json>`（正常路径）。
//   ② 用户自己双击启动：没有 `--bridge`，去读插件留下的**发现文件**。

import { app, BrowserWindow, ipcMain, screen, shell, dialog } from "electron";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const HERE = __dirname;

/** 发现文件名，与 src/companion.js 里那个常量必须一致。 */
const DISCOVERY_FILE = "crystal-vault-float.json";

const ROLES = ["reader", "story"];
const roleOf = (cfg) => (cfg && cfg.role === "story" ? "story" : "reader");

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
    const d = JSON.parse(readFileSync(join(tmpdir(), DISCOVERY_FILE), "utf8"));
    if (!d || !d.port || !d.token) return null;
    const age = Date.now() - Date.parse(d.startedAt || 0);
    if (!Number.isFinite(age) || age > 12 * 3600 * 1000) return null;
    if (d.pid) {
      try {
        process.kill(d.pid, 0); // signal 0 只探测存在性
      } catch {
        return null;
      }
    }
    return d;
  } catch {
    return null;
  }
}

/** 命令行给的优先（它是这次请求的明确意图），没有才退回发现文件。 */
function resolveBridge(argv) {
  const fromArg = readBridgeArg(argv);
  if (fromArg) return fromArg;
  const disc = readDiscovery();
  if (!disc) return null;
  return { ...disc, origin: "http://127.0.0.1:" + disc.port, token: disc.token };
}

// ⚠️ 额外数据里**只放命令行那份**：第二个实例存在的唯一理由是"插件要求再开一扇窗"，
// 而插件总是带 `--bridge`。用户双击时额外数据为空 → 第一个实例把已有窗拉到前台。
const pendingCfg = readBridgeArg(process.argv);
const gotLock = app.requestSingleInstanceLock(pendingCfg ? { cfg: pendingCfg } : {});

if (!gotLock) {
  // 已经有实例在跑了。**别自己再开一扇**——直接退，让第一个实例去处理
  // （它会收到 second-instance）。这便是「装了、好奇双击、命令再也没反应」
  // 那个坑的正解：不抢，而是把意图交过去。
  app.quit();
} else {
  main(pendingCfg || resolveBridge(process.argv));
}

function main(initialCfg) {
  // ⚠️ **这里不许覆盖 `window-all-closed`。**
  //
  // 首版有过一句 `app.on("window-all-closed", () => {})`，本意是防"关旧窗→建新窗"
  // 那一瞬应用自杀。代价是**用户点 ✕ 关掉窗之后进程不退**——隐形僵尸，
  // **永久占着单实例锁**，于是插件那两条命令从此静默失效（2026-10-06 首日
  // 用户自己撞上）。现在关窗就该退，那既是用户期望的，也是不让锁泄漏的唯一办法。
  // 重建窗的场景已经不需要它了：`openRole` 是先建新窗再销毁旧窗。

  /** role -> BrowserWindow。两扇窗各占一格。 */
  const wins = new Map();

  app.on("second-instance", (_e, argv, _cwd, additionalData) => {
    const cfg = (additionalData && additionalData.cfg) || readBridgeArg(argv);
    if (!cfg) {
      // 用户只是又双击了一次图标：把已有的窗拉到前面，别重开。
      const first = [...wins.values()].find((w) => w && !w.isDestroyed());
      if (first) {
        if (first.isMinimized()) first.restore();
        first.focus();
      }
      return;
    }
    openRole(cfg);
  });

  /**
   * 开（或聚焦）某个 role 的窗。
   *
   * **已经有了就只是拉到前面，绝不重开**——重开会把结构窗的相机、阅读器里开着的
   * 文献全丢掉，而用户点那条命令的意思多半是"让我看看它"。
   * 要换档（比如结构窗换一颗晶体）在窗里那颗按钮上做，不必经过这里。
   */
  async function openRole(cfg) {
    const role = roleOf(cfg);
    const exist = wins.get(role);
    if (exist && !exist.isDestroyed()) {
      if (exist.isMinimized()) exist.restore();
      exist.focus();
      // ⚠️ **桥的地址可能变了**（Obsidian 重启过：端口和 token 都是新的）。
      // 这种情况只能重开——配置是走 `additionalArguments` 进渲染进程的，
      // 建窗时定死。所以比一下，不一样才重建。
      if (exist.__bridgeOrigin === cfg.origin && exist.__bridgeToken === cfg.token) return;
    }

    const bounds = await loadBounds(role);
    const win = new BrowserWindow({
      ...bounds,
      // 边看边记那扇要**并排放文献和笔记栏**，420 宽的时候页阵只剩 70px
      // （实测过：427 宽的窗里 `#kb-reader-sheets` 只有 70×636）——那不是窄，
      // 那是没法用。抬到 560 让它至少像样。结构窗那扇没这个约束。
      minWidth: role === "story" ? 360 : 560,
      minHeight: 280,
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
        additionalArguments: ["--float-cfg=" + JSON.stringify(cfg || {})],
      },
    });
    win.__role = role;
    win.__bridgeOrigin = cfg.origin;
    win.__bridgeToken = cfg.token;

    win.once("ready-to-show", () => {
      win.show();
      // ② show() 之后再重申一次 —— 应对那次没查出原因的偶发（见文件头第 3 条）。
      win.setAlwaysOnTop(true, "floating");
    });

    // 窗口位置**存在伴侣自己的 userData 里**，绝不进 Obsidian 的 data.json——
    // 那个跟着 vault 走，笔记本上的坐标会被套到台式机的显示器布局上。
    // **按 role 分开存**：两扇窗各有各的位置，不然它们会互相搬。
    let saveTimer = null;
    const rememberSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) saveBounds(role, win.getBounds());
      }, 400);
    };
    win.on("resize", rememberSoon);
    win.on("move", rememberSoon);
    win.on("closed", () => {
      if (wins.get(role) === win) wins.delete(role);
    });

    win.loadFile(join(HERE, "index.html"));
    startWatchdog(win, cfg);

    const old = wins.get(role);
    wins.set(role, win);
    if (old && !old.isDestroyed()) old.destroy(); // 先建新的再销毁旧的：不出现零窗口
  }

  // 把「这个壳能做的事」交给渲染进程。contextIsolation 开着，只能走 IPC。
  // ⚠️ 用 `event.sender` 定位是哪一扇窗，**不要**闭包捕获某一扇——
  // 两扇窗共用一个 ipcMain，捕获错了就会出现"点 A 的关闭把 B 关了"。
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle("float:minimize", (e) => { const w = winOf(e); if (w) w.minimize(); });
  ipcMain.handle("float:close", (e) => { const w = winOf(e); if (w) w.close(); });
  ipcMain.handle("float:pin", (e, on) => {
    const w = winOf(e);
    if (!w) return false;
    w.setAlwaysOnTop(!!on, on ? "floating" : undefined);
    return w.isAlwaysOnTop();
  });
  ipcMain.handle("float:openExternal", (_e, url) => {
    const u = String(url || "");
    if (!/^https?:/i.test(u)) return false;
    shell.openExternal(u);
    return true;
  });

  app.whenReady().then(() => {
    if (initialCfg) openRole(initialCfg);
    else {
      // 双击启动、但发现文件里没有角色：开边看边记那扇（它是主功能）。
      const disc = readDiscovery();
      if (disc) openRole({ ...disc, origin: "http://127.0.0.1:" + disc.port, role: "reader" });
      else openRole({ role: "reader" }); // 连不上桥——窗会开，并说明该从 Obsidian 里打开
    }
  });
}

// ── 窗口位置（按 role 分开存）────────────────────────────────

function boundsFile(role) {
  return join(app.getPath("userData"), "window-" + (ROLES.includes(role) ? role : "reader") + ".json");
}

async function loadBounds(role) {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(boundsFile(role), "utf8"));
  } catch {
    saved = null;
  }
  // 两扇窗的默认摆位错开一点，免得叠得严丝合缝、看起来像只有一扇。
  const bias = role === "story" ? 60 : 0;
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    const p = screen.getPrimaryDisplay().workArea;
    const w = Math.min(role === "story" ? 900 : 1000, p.width);
    const h = Math.min(720, p.height);
    return {
      width: w,
      height: h,
      x: Math.round(p.x + (p.width - w) / 2) + bias,
      y: Math.round(p.y + (p.height - h) / 2) + bias,
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

async function saveBounds(role, b) {
  try {
    await mkdir(dirname(boundsFile(role)), { recursive: true });
    await writeFile(boundsFile(role), JSON.stringify(b), "utf8");
  } catch {
    /* 记不住位置不该影响用 */
  }
}

// ── 看门狗（每扇窗各一个）────────────────────────────────────

function startWatchdog(win, cfg) {
  if (!cfg || !cfg.origin) return;
  let strikes = 0;
  let told = false;
  const tick = async () => {
    if (win.isDestroyed()) return;
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
