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

const ROLES = ["reader", "story", "card"];
const roleOf = (cfg) => {
  const r = cfg && cfg.role;
  return ROLES.includes(r) ? r : "reader";
};

/**
 * 这一扇窗的**唯一键**。
 *
 * ⚠️ 卡片窗（3.0 刀 44）是**一张卡一扇窗**，所以键必须带上卡片的路径。
 * 按 role 当键的话，点开第二张卡只会把第一扇抬到前面——而用户 10-08 要的
 * 正是「每张卡自己一扇系统窗，浮在所有页面之上、**不随伴侣窗口最小化**」。
 * 那不是"把方块做大一点"能得到的，得是另一个原生窗口。
 *
 * 路径里可能会有 `:` `/` `\` 这些不能进文件名的字符（见 `boundsFile` 的转义）。
 */
const keyOf = (cfg) => {
  const role = roleOf(cfg);
  if (role !== "card") return role;
  return "card:" + String((cfg && cfg.path) || "");
};

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

  /** 窗口键 -> BrowserWindow（见 `keyOf`）。两张卡各占一格，两扇固定窗各占一格。 */
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
    const key = keyOf(cfg);
    const exist = wins.get(key);
    if (exist && !exist.isDestroyed()) {
      if (exist.isMinimized()) exist.restore();
      exist.focus();
      // ⚠️ **桥的地址可能变了**（Obsidian 重启过：端口和 token 都是新的）。
      // 这种情况只能重开——配置是走 `additionalArguments` 进渲染进程的，
      // 建窗时定死。所以比一下，不一样才重建。
      if (exist.__bridgeOrigin === cfg.origin && exist.__bridgeToken === cfg.token) return;
    }

    const bounds = await loadBounds(role, key);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: role === "story" ? 360 : role === "card" ? 320 : 420,
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
    win.__winKey = key;
    // ⚠️ **整份 cfg 留着**：渲染进程里点开一张卡时要**再开一扇窗**，而开窗
    // 需要桥的地址和 token——那份配置是走命令行进来的，主进程不存的话
    // 就只能去问渲染进程要，而那等于把桥的凭据在进程之间递一圈。
    win.__cfg = cfg || {};
    win.__bridgeOrigin = cfg.origin;
    win.__bridgeToken = cfg.token;

    win.once("ready-to-show", () => {
      win.show();
      // ② show() 之后再重申一次 —— 应对那次没查出原因的偶发（见文件头第 3 条）。
      win.setAlwaysOnTop(true, "floating");
    });

    // 窗口位置**存在伴侣自己的 userData 里**，绝不进 Obsidian 的 data.json——
    // 那个跟着 vault 走，笔记本上的坐标会被套到台式机的显示器布局上。
    // **按键分开存**：两张卡各有各的位置，不然它们会互相搬。
    let saveTimer = null;
    const rememberSoon = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) saveBounds(key, win.getBounds());
      }, 400);
    };
    win.on("resize", rememberSoon);
    win.on("move", rememberSoon);
    win.on("closed", () => {
      if (wins.get(key) === win) wins.delete(key);
    });

    win.loadFile(join(HERE, "index.html"));
    startWatchdog(win, cfg);

    const old = wins.get(key);
    wins.set(key, win);
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
  /**
   * 开一张卡的窗（3.0 刀 44）。
   *
   * ⚠️ **这是"每张卡自己一扇系统窗"那条路唯一的入口。** 点卡那一下发生在
   * **渲染进程**里（卡片盒 / 结构窗都在那儿），而开一个**原生窗口**只有主进程
   * 做得到——渲染进程能造出来的只有"自己窗口里的一个方块"，那正是用户不要的
   * （伴侣一最小化它就没了，也拖不出伴侣的窗口）。
   *
   * ⚠️ 桥的配置从**发起那一扇窗**上拿（`w.__cfg`），不重新拼：端口和 token
   * 都在里面，重拼等于把凭据复制一份，两份迟早会不一样。
   *
   * 同一张卡再点一次 = `openRole` 里那条"已有就只聚焦"——**不会开出第二扇**。
   */
  ipcMain.handle("float:openCard", (e, cardPath) => {
    const w = winOf(e);
    if (!w || !w.__cfg) return false;
    const p = String(cardPath || "");
    openRole({ ...w.__cfg, role: "card", path: p });
    return true;
  });
  /**
   * 开（或聚焦）那扇结构窗，顺便让它看某颗晶体（3.0 刀 44）。
   *
   * ⚠️ **光"建窗时带 crystal"不够**：那扇窗很可能已经开着，这时候用户点的是
   * 「换一颗晶体看」——窗已经在了，只是要看的东西变了。所以已有窗那一支要
   * **把新的 key 送进去**（`float:showCrystal`），而不是只把它抬到前面。
   * 只抬不换的症状是「点了换晶体，窗亮了，图还是老的那张」。
   */
  ipcMain.handle("float:openStory", (e, key) => {
    const w = winOf(e);
    if (!w || !w.__cfg) return false;
    const k = String(key || "");
    const exist = wins.get("story");
    if (exist && !exist.isDestroyed()) {
      if (exist.isMinimized()) exist.restore();
      exist.focus();
      if (k) {
        try {
          exist.webContents.send("float:showCrystal", k);
        } catch {
          /* 送不进去就只是没换晶体，不该把这一下点崩 */
        }
      }
      return true;
    }
    openRole({ ...w.__cfg, role: "story", crystal: k });
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

/**
 * 窗口位置的**文件名**。
 *
 * ⚠️ 卡片窗的键里带着**卡片的路径**，而路径里会有 `/`（`3.资产舱/知识卡片/x.md`）
 * 甚至 `:` 这类文件名里不能用的字符。直接拼成文件名会**写失败**，而
 * `saveBounds` 那个空 `catch` 会把它静默吞掉——症状是"这两张卡的位置永远记不住"，
 * 而且一点错都不报。所以先把键转义成安全字符。
 */
function boundsFile(key) {
  const safe = String(key || "reader").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120);
  return join(app.getPath("userData"), "window-" + (safe || "reader") + ".json");
}

async function loadBounds(role, key) {
  let saved = null;
  try {
    saved = JSON.parse(await readFile(boundsFile(key || role), "utf8"));
  } catch {
    saved = null;
  }
  // 几扇窗的默认摆位错开一点，免得叠得严丝合缝、看起来像只有一扇。
  const bias = role === "story" ? 60 : role === "card" ? 120 : 0;
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) {
    const p = screen.getPrimaryDisplay().workArea;
    const w = Math.min(role === "story" ? 900 : role === "card" ? 520 : 1000, p.width);
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

async function saveBounds(key, b) {
  try {
    await mkdir(dirname(boundsFile(key)), { recursive: true });
    await writeFile(boundsFile(key), JSON.stringify(b), "utf8");
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
