# Selection AI for the desktop

The browser shortcut without the browser: the same key, bar, modes, panel, chats and account, over anything on screen — Preview, Acrobat, PowerPoint, Zoom, other extensions' PDF viewers, every browser. A [Tauri 2](https://tauri.app) app, Mac first, then Windows (see the plan, *Selection AI desktop app*).

## What works today

This is the plan's spike and its *Box, Freeform and the panel on Mac* phase, built and tested on Linux (a development target only) and type-checked against the real macOS and Windows system APIs. **Nothing here has run on a Mac or a Windows PC yet** — that is the next step, with the checklist below.

| Area | State |
| --- | --- |
| Option+Shift+S (Alt+Shift+S on Windows), anywhere | global shortcut, no permission; the menu bar (tray) icon's *Select* does the same. If another app holds the key, a tooltip says so once and Settings explains it |
| The bar | the extension's bar, unchanged, in a transparent overlay over the whole display under the pointer, opening from its middle, armed in the last mode used; above full-screen apps and on every Space (macOS); the shortcut moves it to the display under the pointer |
| Box, Freeform | the extension's drawing code; the selection is captured natively and cropped (and masked) natively: ScreenCaptureKit on macOS 14+ with the app's own windows filtered out, GDI on Windows with the app's windows excluded by display affinity |
| Element, Text | chips shown but off ("coming to the app soon"): they need the accessibility API, the plan's next phase |
| While the bar waits | clicks go through to the app beneath everywhere but on the bar and its tooltips |
| Panel | the extension's side panel, unchanged, in a window docked to the right edge of the selection's display, floating above other apps; closing it finishes the chat, as ✕ on Chrome's side panel does |
| Chats, temporary chats, macros, model picker, answers | the extension's code; one chat at a time (one panel); a selection is named after the window it was made over ("Chapter 3.pdf · Preview") |
| Who answers | placeholder, your own Anthropic or OpenAI key, a local model, hosted answers — every request goes out through the native core, so no browser CORS rule applies |
| Settings | the extension's settings page in a window, with the app's shortcut, a Permissions section on macOS (Screen Recording: status, *Open System Settings*, *Restart*), no blocked sites (blocked apps come later) and no PDF reader (not needed) |
| Storage | chats in JSON files, screenshots as image files, under the app's data folder; temporary chats in memory only; API keys and the account session in the macOS Keychain / Windows Credential Manager |
| Accounts | email sign-in, cloud storage and hosted answers as in the extension (same build variables). Google sign-in needs the `selectionai://` link, the next phase; until then its button is not shown |
| Escape | before anything is selected: never mind, everything goes; while selecting: stops that selection. *While the bar waits* it works only when the bar has the keyboard (after clicking it), since the app does not take Escape from the app you are working in |

## Running it

On a Mac (macOS 14 or later), once:

```bash
xcode-select --install                                   # the compilers
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
pnpm install
```

Then:

```bash
pnpm desktop:dev          # the app with live reload (Vite on :5180)
pnpm desktop:build        # a release .app and .dmg in desktop/src-tauri/target/release/bundle
```

The app lives in the menu bar (no Dock icon). The first Option+Shift+S asks for **Screen Recording**: turn *Selection AI* on in System Settings → Privacy & Security → Screen & System Audio Recording, then press *Restart* in the tooltip (macOS applies the switch to a fresh process only). During development macOS may ask for Screen Recording and for keychain access again after a rebuild, because each build is a new unsigned binary.

Accounts and hosted answers read the same `extension/.env.local` as the extension (`WXT_SUPABASE_URL`, `WXT_SUPABASE_KEY`, `WXT_GATEWAY_URL`).

## Spike checklist (the plan's first gate)

*Gate: overlay and capture work across displays and over full-screen apps, or the overlay goes native.*

1. Option+Shift+S over Preview: the bar opens from its middle at the bottom of the screen, Box armed; the cursor is a crosshair everywhere.
2. Drag a box over part of a PDF: the panel opens docked right, the selection shows in it, and Explain answers (placeholder answers need no key).
3. The bar waits: clicking and scrolling in Preview work everywhere except on the bar.
4. Freeform: the panel shows only the inside of the shape; ✕ closes bar and panel; Escape before selecting closes the bar.
5. Full screen: put Preview (or Keynote) in full screen, press the shortcut: the bar comes up over it, a box works, the panel appears next to it without leaving the full-screen Space.
6. Two displays (ideally Retina + standard, one left of the main display): with the pointer on each, the shortcut brings the bar to that display and a box there is cropped exactly (no offset, no scaling).
7. Stage Manager on: the same.
8. Screen Recording off (System Settings): the shortcut shows the yellow tooltip with *Open System Settings* and *Restart*.

Anything that fails in 1, 3, 5 or 6 is the spike's question: whether the transparent overlay holds up, or becomes a small native window.

## How it is built

A small native core does only what the system must; the extension's own code runs everything else in four windows.

```
desktop/
├── src-tauri/            the native core (Rust)
│   ├── src/lib.rs        commands, the shortcut, the menu bar icon, app setup
│   ├── src/wm.rs         the four windows; click-through polling for the waiting bar
│   ├── src/geometry.rs   displays, the pointer, where the overlay and panel go (mixed scales, negative coordinates)
│   ├── src/capture/      a display's screenshot without our windows: macos.rs (ScreenCaptureKit), windows.rs (GDI), linux.rs (X11, tests)
│   ├── src/crop.rs       crop, freeform mask, downscale to 1568 px, PNG
│   ├── src/store.rs      storage.local/session, screenshot files, the keychain
│   └── src/testhook.rs   the end-to-end tests' hook (debug builds with --features test-hook only)
├── src/
│   ├── platform/         the WebExtension API the shared code uses, over the native core (browser.ts), files for screenshots, network, links
│   ├── core/             the hidden core window: the extension's background, desktop half (the chat half is extension/lib/engine.ts)
│   ├── overlay/          the overlay window: the extension's SelectionController; which parts take the pointer; tooltips
│   ├── panel/, settings/ the extension's panel and settings page; the app's shortcut field and Permissions section
│   ├── brand.ts, surface.tsx   what the app says differently ("any app", "the menu bar icon")
├── web/                  the four pages (and a fixture page for the tests)
├── tests/e2e/            the app end to end, on a virtual display
└── vite.config.ts        aliases that swap the extension's browser plumbing for the app's
```

The rule that keeps the two in step: **the app does not fork the extension's code**. The extension's background is split into `extension/lib/engine.ts` (chats, answers, the cloud copy, the connection status — shared) and the browser half; the app's core window is the desktop half on top of the same engine. Copy that differs reads from `extension/lib/surface.ts`, which the app's build replaces with `src/surface.tsx`; `@/brand` likewise. Everything else (`lib/`, `ui/`, the settings page, the bar and the selectors) is imported as is.

How the extension's browser APIs map:

| Extension | App |
| --- | --- |
| `storage.local` | JSON files under `<app data>/store/local`, one per key; `keys` and `account` in the system keychain |
| `storage.session` | memory in the native core, shared by the windows |
| IndexedDB screenshots | files under `<app data>/store/images/<chat id>/` |
| `runtime.sendMessage` / `onMessage` | Tauri events to the core window, which answers |
| the panel's port | an event-based port; it disconnects when the panel window closes |
| `captureVisibleTab` + canvas crop | `capture_selection`: native capture, crop and mask |
| `sidePanel.open/close` | `panel_open` / `panel_close` |
| `fetch` from the background | `tauri-plugin-http` (the native core), for any other origin |

## Tests

```bash
pnpm test                               # includes tests/unit/desktop-browser.test.ts (the WebExtension shim, several windows in memory)
pnpm --filter desktop test:native       # Rust: display geometry, crop and mask, storage and keychain
pnpm --filter desktop test:e2e          # the real app on a virtual X display (Linux: Xvfb, xdotool, ImageMagick)
```

The end-to-end tests drive the app the way a student does — the real shortcut, the real pointer and keys through the X server, a real screen capture over a window with known pixels — and read the results back: the crop's pixels, the request body a (fake) local model receives, which windows show. They cover: the shortcut and the bar, a box (exact pixels, the panel docked right, the bar waiting), freeform (outside painted white), an answer streamed from a model, click-through while waiting, ✕, Escape both ways, closing the panel, two selections in one chat, the ghost, and settings from the gear.

On Linux the overlay draws black (a virtual display has no compositor) and the capture steps it aside; on macOS and Windows the system leaves the app's windows out instead.
