# Tray Grass-Block Mascot — Design

**Date:** 2026-06-12
**Status:** Approved (pending implementation plan)

## Problem

When MCPANEL runs in the background, its system-tray slot shows a **blank space**
instead of an icon, so there's no visual indication the program is running.

### Root cause (verified)

- `assets/logo.png` is **not a PNG** — it is a 1024×1024 **JPEG** with a `.png`
  filename (`file` reports `JPEG image data ... 1024x1024`).
- `scripts/build-icons.js` reads that file's raw bytes and wraps them in an `.ico`
  container whose directory entry declares a single 256×256, 32-bpp frame.
- **The ICO format does not support JPEG-encoded frames** — only BMP/DIB or PNG
  frames are valid. The resulting `assets/logo.ico` is therefore malformed:
  Windows cannot decode the frame, so the tray renders an empty slot.

`trayManager.ts` itself is correct — it points at `logo.ico` on Windows / `logo.png`
elsewhere. The defect is entirely in the icon **files** and the script that builds them.

### Scope finding

`logo.png` / `logo.ico` are referenced **only** by:
- `src/managers/trayManager.ts` (the tray icon)
- `scripts/build-icons.js` (the builder)

The Windows installer shortcut uses `cmd.exe`'s icon, and the README banner uses
`assets/banner.svg`. So these two files are effectively the tray mascot and nothing
else — they can be replaced cleanly without affecting branding or the installer.

## Goal

Replace the malformed icon files with a crisp **Minecraft grass-block** mascot so
the tray displays a real picture. **Tray-only scope** — no CLI banner or startup
changes (YAGNI).

## Design

### 1. Mascot art

A classic grass block rendered as **pixel art** (procedurally, in plain Node):

- Green grass top with a slight 3D top-face highlight.
- Brown dirt body with a few darker speckle pixels for texture.
- A green grass "overhang" lip just below the top edge.

Drawn on a small grid so it remains legible when scaled down to 16×16 (the size
Windows requests most often in the tray).

### 2. Rewritten `scripts/build-icons.js`

Zero new dependencies (uses only built-in `fs` / `zlib` / `Buffer`). It will:

1. Procedurally render the grass block into RGBA pixel buffers at **16, 32, 48, 256**.
2. Write `assets/logo.png` as a **genuine PNG** (256×256) using Node's built-in `zlib`
   for the IDAT deflate stream.
3. Write `assets/logo.ico` as a **valid multi-frame ICO**:
   - Frames at **16, 32, 48** (the sizes the tray requests; 256 lives in the PNG
     only, to keep the ICO small).
   - Each frame stored as an **uncompressed 32-bit BGRA BMP (DIB)** with a proper
     AND mask — decodable on every Windows version, avoiding any reliance on
     PNG-in-ICO support inside the systray2 native helper.
4. Be wired into `package.json` so the icon is regenerated as part of the build
   (e.g. a `build:icons` script plus a `prebuild` hook), preventing the files from
   drifting back into a broken state.

### 3. `trayManager.ts`

No logic change required — it already selects `logo.ico` (Windows/WSL) or `logo.png`
(other). Verify end-to-end only.

### 4. Verification

- Programmatically validate `assets/logo.ico`: correct ICO header, expected frame
  count, declared sizes match (16/32/48[/256]), and frames are BMP/DIB (not JPEG).
- Confirm `assets/logo.png` has a valid PNG signature.
- Run the tray and visually confirm the grass-block mascot appears (not blank).

## Out of scope

- Showing the mascot anywhere besides the tray (CLI banner, startup splash).
- Animated / state-dependent tray icons (e.g. different icon when server running).
- Changing the installer shortcut icon or the README banner.

## Approaches considered

- **A (chosen):** Hand-rolled pixel art → multi-size ICO with uncompressed BMP
  frames + real PNG. Zero deps, matches existing style, maximal Windows compatibility.
- **B:** Add `sharp` / `png-to-ico`. Heavy native dependency for one icon — rejected.
- **C:** Hand-rolled but with PNG-compressed ICO frames. Smaller file but relies on
  Vista+ PNG-in-ICO decoding in the native helper — slightly riskier, rejected.
