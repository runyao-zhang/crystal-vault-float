// 预加载脚本 —— 主进程和渲染进程之间**唯一**那道门。
//
// contextIsolation 开着，所以渲染进程拿不到 Node，只能拿到这里显式交出去的东西。
// 交出去的一共两样：桥的地址（配置），和这个壳能做的四件事。
//
// 配置走 `additionalArguments`（主进程 spawn 时拼在 argv 里）而不是写在文件里：
// 端口每次启动都不一样，token 每次重新生成，没有任何可缓存的东西。

import { contextBridge, ipcRenderer } from "electron";

function readCfg() {
  const PREFIX = "--float-cfg=";
  const hit = (process.argv || []).find((a) => typeof a === "string" && a.startsWith(PREFIX));
  if (!hit) return {};
  try {
    return JSON.parse(hit.slice(PREFIX.length));
  } catch {
    return {};
  }
}

contextBridge.exposeInMainWorld("__CRYSTAL_FLOAT__", readCfg());

// 渲染进程能对窗口做的四件事。**只暴露动作，不暴露 Electron 对象**——
// 交一个 ipcRenderer 出去等于把整条 IPC 面全打开。
contextBridge.exposeInMainWorld("__FLOAT_SHELL__", {
  minimize: () => ipcRenderer.invoke("float:minimize"),
  close: () => ipcRenderer.invoke("float:close"),
  pin: (on) => ipcRenderer.invoke("float:pin", !!on),
  openExternal: (url) => ipcRenderer.invoke("float:openExternal", String(url || "")),
});
