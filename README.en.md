# CrystalFloat · a floating companion for Crystal Vault

Puts [Crystal Vault](https://github.com/runyao-zhang/crystal-vault)'s
**read-and-note** view and **structure window** into a standalone window that stays
on top of other applications — look something up in Edge and the window is still there.

---

## Why a second program

Not laziness — a platform limit.

The Crystal Vault plugin runs inside Obsidian's own renderer process. The "floating
window" it can make (the three modes in settings: full / windowed / embedded)
**can never leave Obsidian's own window**. To sit above Edge, WeChat or Word, you need
a native window carrying the OS-level always-on-top flag — and that requires a
separate process.

An Obsidian plugin sandbox cannot do this. In the entire Crystal Vault codebase there is
exactly one use of Electron: handing a URL to the system browser.

So:

| | Size | Where from |
|---|---|---|
| Crystal Vault plugin | ~2 MB | Obsidian community plugin store (unchanged) |
| **CrystalFloat** | ~107 MB | this repo's Releases |

Once installed, the plugin **finds it automatically** — no path to configure.

---

## Install

1. Download `CrystalFloat-<version>-x64.exe` from [Releases](../../releases/latest)
2. Run it. **No admin rights needed**; you can pick the install directory
3. When Windows shows the blue block screen: **More info** → **Run anyway**

### About that blue screen

This program is **not code-signed** (certificates cost money annually), so
SmartScreen intercepts the first launch. You only have to do this once.

If you'd rather not install anything, grab `CrystalFloat-portable-<version>.exe` —
a single self-extracting file that runs wherever you unpack it and never appears in
"Add or remove programs".

---

## Using it

In Obsidian, open the command palette (`Ctrl+P`). Two commands:

- **Crystal Vault: Floating window: read and note**
- **Crystal Vault: Floating window: structure window**

The window has a drag strip along the top; on the right are **on-top toggle /
minimize / close**.

Closing Obsidian closes the floating window — it has no data source on its own.
Closing the floating window does **not** affect Obsidian.

---

## What "on top" actually beats

An honest list.

**Beats**: Edge, Chrome, WeChat, QQ, Word, Explorer — regular windows, maximized
included.

**Does not beat**:
- Exclusive-fullscreen apps (fullscreen video, games)
- **Another always-on-top window** — when two windows share that band, whichever was
  activated last wins. If you run Raycast (on-top by default) or certain
  screenshot/recording tools, you will hit this
- UAC elevation prompts (those live on the secure desktop; nothing gets above them)
- The taskbar while it is auto-hidden

If it ever ends up underneath, toggle the on-top button off and on again, or
minimize and restore.

---

## Known trade-offs

**These are real, not boilerplate.**

1. **Editing a card body inside the floating window uses a plain textarea**, not
   Obsidian's live-preview editor. Obsidian's editor component cannot cross a process
   boundary. Turning PDF pages, dragging cards and writing notes all work — only the
   editing experience itself is downgraded.

2. **`[[wikilinks]]` and callouts inside a floated document render as plain text**, and
   plugin-provided markdown extensions (Dataview and friends) do not apply. The floating
   window uses its own renderer.

3. **Don't drag the same card in both windows at once.** Card coordinates are written
   with debouncing and without a baseline comparison, so a simultaneous edit means one
   side wins silently. Sequential edits are fine — changes propagate over the live push.

4. **If Obsidian quits mid-edit, unsaved changes in the floating window are lost**, and
   they are **not retried automatically**. That is deliberate: a retry would overwrite
   newer content with stale content. The window says so plainly instead of pretending
   nothing happened.

---

## Building from source

```bash
npm ci
npm run dist        # installers land in dist/float-dist/
```

Node 20+. The first run downloads Electron and the NSIS toolchain — a few hundred MB.

> ⚠️ **`src/` and `floating/` in this repo are build inputs synced from
> [ari-crystal](https://github.com/runyao-zhang/ari-crystal)** via
> `scripts/land-float.mjs`. Editing them here gets overwritten on the next sync —
> change the upstream instead.

## License

GPL-3.0, same as Crystal Vault.
