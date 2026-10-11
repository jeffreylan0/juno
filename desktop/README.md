# Selection AI for the desktop

The browser shortcut without the browser: the same key, bar, modes, panel, chats and account, over anything on screen — Preview, Acrobat, PowerPoint, Zoom, other extensions' PDF viewers, every browser. A [Tauri 2](https://tauri.app) app, Mac first, then Windows (see the plan, *Selection AI desktop app*).

## What works today

This is the plan's spike, its *Box, Freeform and the panel on Mac* phase and Text and Element, built and tested on Linux (a development target only) and type-checked against the real macOS and Windows system APIs. The product owner has started it on a Mac; the checklist below is what to try there.

| Area | State |
| --- | --- |
| Option+Shift+S (Alt+Shift+S on Windows), anywhere | global shortcut, no permission. Clicking the menu bar (tray) icon, or opening the app (again), does the same; right-clicking the icon opens a small menu (Select, Settings…, Quit). If another app holds the key, the bar says so once and Settings explains it |
| The bar | the extension's bar — one quiet dark row in the manner of Claude's quick entry — in a transparent overlay over the whole display under the pointer, opening from its middle, armed in the last mode used, with the screen dimmed a little while a selection is armed; small tooltips come up after a moment; above full-screen apps and on every Space (macOS); the shortcut moves it to the display under the pointer |
| Sending | as the setting says (*After drawing a selection*): at once, or once ↑ on the bar (or Enter) is pressed, after adjusting a box or redrawing an outline |
| Screen Recording (macOS) | until it is allowed, the bar comes up with nothing armed and a note under its row: *Turn on Screen Recording* (the system's prompt, then System Settings) or *Not now* (select anyway); once asked, the note offers *Restart* |
| Box, Freeform | the extension's drawing code; the selection is captured natively and cropped (and masked) natively: ScreenCaptureKit on macOS 14+ with the app's own windows filtered out, GDI on Windows with the app's windows excluded by display affinity |
| Text, Element | **off for now** (not on the bar), until it is decided how the app should reach what other apps show: see *Text and Element: the options* below. Built and tested on reading the screen on this computer (Vision on macOS, Windows.Media.Ocr on Windows): drag across words as in Live Text, or hover a paragraph or window. `VITE_SCREEN_MODES=1 pnpm desktop:dev` turns them on to try |
| While the bar waits | clicks go through to the app beneath everywhere but on the bar and its tooltips |
| Panel | the extension's side panel as a card like the bar: no title bar (its top bar drags it), rounded, a short rise in and fade out, at the top right of the selection's display, floating above other apps. It starts small and grows down with its chat until it reaches the bottom of the screen; resized by hand, it stays. Its ✕ (or closing it) finishes the chat, as ✕ on Chrome's side panel does. It shows only once it has drawn, so it never flashes white |
| Chats, temporary chats, macros, model picker, answers | the extension's code; one chat at a time (one panel); a selection is named after the window it was made over ("Chapter 3.pdf · Preview") |
| Who answers | placeholder, your own Anthropic or OpenAI key, a local model, hosted answers — every request goes out through the native core, so no browser CORS rule applies |
| Settings | the extension's settings page in the same palette, as a card in the middle of the screen, with the app's shortcut, a Permissions section on macOS (Screen Recording: status, *Open System Settings*, *Restart*, and what the app does and does not ask for), no blocked sites (blocked apps come later) and no PDF reader (not needed) |
| Permissions | **Screen Recording only**, on macOS (Windows asks for nothing). No keychain, no accessibility access, no microphone, no input monitoring. macOS names the switch "Screen & System Audio Recording"; the app records no audio |
| Quit | Settings → Selection AI → *Quit Selection AI*, ⌘Q in the panel or settings, or the menu bar icon's right-click menu |
| Storage | chats in JSON files, screenshots as image files, under the app's data folder; temporary chats in memory only; API keys and the account session in one file only your account can read (`secrets.json`, mode 0600), as the browser keeps the extension's. Not the keychain: macOS ties a keychain item to the exact build that made it, so each new build asked for the keychain password, and once refused, asked at every read |
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

The app lives in the menu bar (no Dock icon). Opening it brings the bar straight up (`--hidden` starts it without, for starting at login). The first time, the bar asks for **Screen Recording**: *Turn on Screen Recording*, switch *Selection AI* on in System Settings → Privacy & Security → Screen & System Audio Recording, then press *Restart* on the bar (macOS applies the switch to a fresh process only).

**Try the app's permissions with `pnpm desktop:app`, not `pnpm desktop:dev`.** `desktop:dev` runs a bare binary from your terminal, so macOS asks on behalf of whatever started it ("Visual Studio Code is requesting to bypass the system private window picker…") and would give *that* app Screen Recording. Don't allow it; if you did, switch the editor off again in System Settings. `desktop:app` builds a real (debug) `Selection AI.app` and opens it, so the prompt names Selection AI and the permission is the app's alone. Signed ad hoc, each rebuild is a new app to macOS and it asks again; set `APPLE_SIGNING_IDENTITY` to your Apple Development certificate and the permission survives rebuilds.

Earlier builds kept API keys in the keychain, under "Selection AI"; the app no longer reads them (reading would ask again), so enter your keys once more in Settings. The old items can be deleted in Keychain Access.

Accounts and hosted answers read the same `extension/.env.local` as the extension (`WXT_SUPABASE_URL`, `WXT_SUPABASE_KEY`, `WXT_GATEWAY_URL`).

## Spike checklist (the plan's first gate)

*Gate: overlay and capture work across displays and over full-screen apps, or the overlay goes native.*

1. Open the app: the bar opens from its middle at the bottom of the screen, asking for Screen Recording the first time. After that, Option+Shift+S over Preview: the screen dims a little, the bar comes up with Box armed, the cursor is a crosshair everywhere, and resting it a moment shows *Drag to select* beside it.
2. Drag a box over part of a PDF: the panel comes in as a card at the top right, the selection shows in it, and Explain answers (placeholder answers need no key). The panel grows with the answer and stops at the bottom of the screen.
3. The bar waits: clicking and scrolling in Preview work everywhere except on the bar.
4. Freeform: the panel shows only the inside of the shape; ✕ closes bar and panel; Escape before selecting closes the bar.
5. Full screen: put Preview (or Keynote) in full screen, press the shortcut: the bar comes up over it, a box works, the panel appears next to it without leaving the full-screen Space.
6. Two displays (ideally Retina + standard, one left of the main display): with the pointer on each, the shortcut brings the bar to that display and a box there is cropped exactly (no offset, no scaling).
7. Stage Manager on: the same.
8. Screen Recording off (System Settings): the shortcut brings the bar up with the note under it; *Turn on Screen Recording* opens System Settings, and the next shortcut offers *Restart*.
9. Switching modes, opening the panel or settings, finishing a selection: no flash anywhere (the dim fades out; windows appear only once drawn).
10. Click the menu bar icon: the bar comes up at once. Right-click it: Select, Settings…, Quit. No keychain prompt, ever; keys entered in Settings work for asking.

Anything that fails in 1, 3, 5 or 6 is the spike's question: whether the transparent overlay holds up, or becomes a small native window.

## Text and Element: the options

On a page, the extension reads the DOM: the exact characters a student highlights, and real elements (a paragraph, an equation, a table). Other apps have no DOM the app can see, so the app needs another way in. What exists:

| Option | What the student does | Exact? | Permission | Covers |
| --- | --- | --- | --- | --- |
| **A. Browser bridge** — the app and the extension talk (native messaging) | selects as today; over a browser window, the extension does Text and Element in the page's real DOM and hands the result to the app's chat | yes, as the extension (KaTeX/MathJax as LaTeX, real elements) | none (the extension must be installed) | Chrome, Edge, Firefox, Safari later: websites, web PDFs via the reader, LMS pages |
| **B. macOS Services** — "Ask Selection AI" in the right-click menu (and a key the student can assign) | highlights text the usual way in any app, then right-click → Ask Selection AI | yes, the app's own characters | none | Text in nearly every Mac app (Preview, Pages, Word, Notes, Safari, Chrome); not Element. Windows: UI Automation reads the selection without a permission |
| **C. Accessibility** (macOS AX, Windows UI Automation) | highlights in the app, or hovers an element, as on a page | yes, and real elements with their positions | macOS: *Accessibility* (lets the app read and control other apps); Windows: none | native apps that expose it (Preview, Pages, Word, Mail); weak in Electron and canvas apps (Figma, Google Docs' canvas) |
| **D. Copy, then the shortcut** | ⌘C, then ⌥⇧S: the bar offers "Ask about the copied text" | yes | none today (newer macOS versions add a prompt for reading the clipboard) | every app; one more keystroke |
| **E. Read the screen** (built, off) | drags across words on the dimmed screen, or hovers a paragraph | close, not exact (maths loses superscripts) | none beyond Screen Recording | anything visible, scans and videos included |

## How it is built

A small native core does only what the system must; the extension's own code runs everything else in four windows.

```
desktop/
├── src-tauri/            the native core (Rust)
│   ├── src/lib.rs        commands, the shortcut, the menu bar icon, app setup
│   ├── src/wm.rs         the four windows; click-through polling for the waiting bar
│   ├── src/geometry.rs   displays, the pointer, where the overlay and panel go (mixed scales, negative coordinates)
│   ├── src/capture/      a display's screenshot without our windows: macos.rs (ScreenCaptureKit), windows.rs (GDI), linux.rs (X11, tests); the windows on screen
│   ├── src/read/         the screen's text, word by word, read on this computer: macos.rs (Vision), windows.rs (Windows.Media.Ocr), linux.rs (tesseract, tests)
│   ├── src/crop.rs       crop, freeform mask, downscale to 1568 px, PNG
│   ├── src/store.rs      storage.local/session, screenshot files, the private secrets file
│   └── src/testhook.rs   the end-to-end tests' hook (debug builds with --features test-hook only)
├── src/
│   ├── platform/         the WebExtension API the shared code uses, over the native core (browser.ts), files for screenshots, network, links
│   ├── core/             the hidden core window: the extension's background, desktop half (the chat half is extension/lib/engine.ts)
│   ├── overlay/          the overlay window: the extension's SelectionController; which parts take the pointer; the bar's notes
│   ├── panel/, settings/ the extension's panel and settings page; the app's shortcut field and Permissions section; the panel fitting its chat
│   ├── card.ts           the panel and settings as cards: drag by the top bar, the entrance and exit, shown once drawn
│   ├── brand.ts, surface.tsx   what the app says differently ("any app", "the menu bar icon")
├── web/                  the four pages (and a fixture page for the tests)
├── tests/e2e/            the app end to end, on a virtual display
└── vite.config.ts        aliases that swap the extension's browser plumbing for the app's
```

The rule that keeps the two in step: **the app does not fork the extension's code**. The extension's background is split into `extension/lib/engine.ts` (chats, answers, the cloud copy, the connection status — shared) and the browser half; the app's core window is the desktop half on top of the same engine. Copy that differs reads from `extension/lib/surface.ts`, which the app's build replaces with `src/surface.tsx`; `@/brand` likewise. Everything else (`lib/`, `ui/`, the settings page, the bar and the selectors) is imported as is.

How the extension's browser APIs map:

| Extension | App |
| --- | --- |
| `storage.local` | JSON files under `<app data>/store/local`, one per key; `keys` and `account` in `<app data>/store/secrets.json`, private to the user |
| `storage.session` | memory in the native core, shared by the windows |
| IndexedDB screenshots | files under `<app data>/store/images/<chat id>/` |
| `runtime.sendMessage` / `onMessage` | Tauri events to the core window, which answers |
| the panel's port | an event-based port; it disconnects when the panel window closes |
| `captureVisibleTab` + canvas crop | `capture_selection`: native capture, crop and mask |
| `sidePanel.open/close` | `panel_open` / `panel_close` (and `panel_fit`, `window_show`) |
| the page's DOM, for Text and Element | `read_screen`: the screen's text and windows, read on this computer (`extension/lib/screen-text.ts` lays them out) |
| `fetch` from the background | `tauri-plugin-http` (the native core), for any other origin |

## Tests

```bash
pnpm test                               # includes tests/unit/desktop-browser.test.ts (the WebExtension shim, several windows in memory)
pnpm --filter desktop test:native       # Rust: display geometry, crop and mask, storage and the secrets file
pnpm --filter desktop test:e2e          # the real app on a virtual X display (Linux: Xvfb, xdotool, ImageMagick, tesseract-ocr)
```

The end-to-end tests drive the app the way a student does — the real shortcut, the real pointer and keys through the X server, a real screen capture over a window with known pixels — and read the results back: the crop's pixels, the request body a (fake) local model receives, which windows show. They cover: opening the app, the shortcut and the bar, the Screen Recording note both ways, a box (exact pixels, the panel card at the top right, the bar waiting), freeform (outside painted white), Text (the fixture's sentence read off the screen and selected exactly) and Element (a paragraph, ↑ ↓, its crop) — built with `VITE_SCREEN_MODES=1`, since they are off otherwise — an answer streamed from a model, click-through while waiting, ✕, Escape both ways, closing the panel, two selections in one chat (the panel growing to fit them), the ghost, settings from the gear, and Quit.

On Linux the overlay draws black (a virtual display has no compositor) and the capture steps it aside; on macOS and Windows the system leaves the app's windows out instead.
