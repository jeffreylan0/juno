# Selection AI for the desktop

The browser shortcut without the browser: the same key, bar, modes, panel, chats and account, over anything on screen — Preview, Acrobat, PowerPoint, Zoom, other extensions' PDF viewers, every browser. A [Tauri 2](https://tauri.app) app, Mac first, then Windows (see the plan, *Selection AI desktop app*).

## What works today

This is the plan's spike and its *Box, Freeform and the panel on Mac* phase, with accounts and plans, built and tested on Linux (a development target only) and built for the real macOS and Windows system APIs. The product owner has started it on a Mac; the checklist below is what to try there.

| Area | State |
| --- | --- |
| Option+Shift+S (Alt+Shift+S on Windows), anywhere | global shortcut, no permission. Clicking the menu bar (tray) icon, or opening the app (again), does the same; right-clicking the icon opens a small menu (Select, Settings…, Quit). If another app holds the key, the bar says so once and Settings explains it |
| The bar | the extension's bar — one quiet dark row in the manner of Claude's quick entry — in a transparent overlay over the whole display under the pointer, opening from its middle, armed in the last mode used, with the screen dimmed a little while a selection is armed; small tooltips come up after a moment; above full-screen apps and on every Space (macOS); the shortcut moves it to the display under the pointer |
| Sending | as the setting says (*After drawing a selection*): at once, or once ↑ on the bar (or Enter) is pressed, after adjusting a box or redrawing an outline |
| Screen Recording (macOS) | until it is allowed, the bar comes up with nothing armed and a note under its row: *Turn on Screen Recording* (the system's prompt, then System Settings) or *Not now* (select anyway); once asked, the note offers *Restart* |
| Box, Freeform | the extension's drawing code; the selection is captured natively and cropped (and masked) natively: ScreenCaptureKit on macOS 14+ with the app's own windows filtered out, GDI on Windows with the app's windows excluded by display affinity |
| While the bar waits | clicks go through to the app beneath everywhere but on the bar and its tooltips |
| Scrolling while armed | the wheel (or trackpad) scrolls the app beneath, under the dim, which stays put; the overlay lets the pointer through until it moves, then takes it back to select. Not while drawing or adjusting (the selection is pinned to the screen). The overlay page itself never scrolls or bounces, which is what made the dim flash |
| Panel | the extension's side panel as a card like the bar, at the top right of the selection's display, floating above other apps. On macOS a real window with its title bar hidden, so the system rounds it and draws its shadow; its top bar drags it; its content rises in and fades out. **Made when the app starts and kept**, hidden between chats, so it shows the moment a selection is made, with a placeholder for the selection until the screenshot is in. It opens 72% of the display tall and grows down with its chat to the bottom of the screen; resized by hand, it stays so until it next opens. Its ✕ finishes the chat, as ✕ on Chrome's side panel does |
| Chats, temporary chats, macros, model picker, answers | the extension's code; one chat at a time (one panel); a selection is named after the window it was made over ("Chapter 3.pdf · Preview") |
| Who answers | placeholder, your own Anthropic or OpenAI key, a local model, hosted answers — every request goes out through the native core, so no browser CORS rule applies |
| Settings | the extension's settings page in the same palette, as a card (a real window, as the panel) in the middle of the screen; once it is on screen the bar and the dim go (the chat carries on; the shortcut brings the bar back). With the app's shortcut, a Permissions section on macOS (Screen Recording: status, *Open System Settings*, *Restart*, and what the app does and does not ask for), no blocked sites (blocked apps come later) and no PDF reader (not needed) |
| Permissions | **Screen Recording only**, on macOS (Windows asks for nothing). No keychain, no accessibility access, no microphone, no input monitoring. macOS names the switch "Screen & System Audio Recording"; the app records no audio |
| Quit | Settings → Selection AI → *Quit Selection AI*, ⌘Q in the panel or settings, or the menu bar icon's right-click menu |
| Open at login | Settings → Selection AI, off until turned on: the app starts in the menu bar only (`--hidden`). No permission: a launch agent in `~/Library/LaunchAgents` on macOS (the system may say a background item was added), the user's Run key on Windows |
| Storage | chats in JSON files, screenshots as image files, under the app's data folder (`~/Library/Application Support/org.humanbn.selectionai` on macOS); temporary chats in memory only; API keys and the account session in one file only your account can read (`secrets.json`, mode 0600), as the browser keeps the extension's. Not the keychain: macOS ties a keychain item to the exact build that made it, so each new build asked for the keychain password, and once refused, asked at every read |
| Accounts and plans | as in the extension (same build variables): email codes, and Google, which opens in the student's browser and comes back through the app's `selectionai://auth/callback` link (registered from the bundle on macOS, at first run on Windows); plans, Stripe checkout and the billing portal open in the browser too. Setup: `supabase/README.md` |
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

The app's bundle id is `org.humanbn.selectionai` (round 23). Builds before that used another id, so to macOS this is a new app: Screen Recording is asked for again, and keys and chats saved by those builds stay in their old folder under `~/Library/Application Support/` (delete it once you no longer need it). Earlier still, keys were kept in the keychain under "Selection AI"; the old items can be deleted in Keychain Access.

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
11. Box armed, scroll with the trackpad over Preview: the page scrolls under the dim, which never flickers; moving the pointer and dragging selects as usual.
12. A selection: the panel is there at once with a shimmering placeholder, then the screenshot. Its corners and shadow look like any Mac window's, with no halo. The gear opens settings and the bar and dim go; the macro rows show name, prompt and ✕ side by side.
13. With the bar up, the gear → *All settings*: settings come up (in round 22 they did not: the app hid itself), then the bar and dim go.
14. In a build with accounts (`supabase/README.md`): Settings → Account → *Continue with Google* opens the browser; after signing in it asks to open Selection AI, and settings come back signed in.

Anything that fails in 1, 3, 5 or 6 is the spike's question: whether the transparent overlay holds up, or becomes a small native window.

## How it is built

A small native core does only what the system must; the extension's own code runs everything else in four windows.

```
desktop/
├── src-tauri/            the native core (Rust)
│   ├── src/lib.rs        commands, the shortcut, the menu bar icon, the app's link (sign-in), app setup
│   ├── src/wm.rs         the four windows; click-through polling for the waiting bar
│   ├── src/geometry.rs   displays, the pointer, where the overlay and panel go (mixed scales, negative coordinates)
│   ├── src/capture/      a display's screenshot without our windows: macos.rs (ScreenCaptureKit), windows.rs (GDI), linux.rs (X11, tests); the window a selection was made over
│   ├── src/crop.rs       crop, freeform mask, downscale to 1568 px, PNG
│   ├── src/store.rs      storage.local/session, screenshot files, the private secrets file
│   └── src/testhook.rs   the end-to-end tests' hook (debug builds with --features test-hook only)
├── src/
│   ├── platform/         the WebExtension API the shared code uses, over the native core (browser.ts, with sign-in through the app's link), files for screenshots, network, links
│   ├── core/             the hidden core window: the extension's background, desktop half (the chat half is extension/lib/engine.ts)
│   ├── overlay/          the overlay window: the extension's SelectionController; which parts take the pointer; the bar's notes
│   ├── panel/, settings/ the extension's panel and settings page; the app's shortcut field and Permissions section; the panel fitting its chat
│   ├── card.ts           the panel and settings as cards: drag by the top bar, the entrance and exit (`card:enter`/`card:leave` for the kept panel), settings shown once drawn
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
| the panel's port | an event-based port; the panel is only ever hidden, so it disconnects only if its page goes away |
| `captureVisibleTab` + canvas crop | `capture_selection`: native capture, crop and mask |
| `sidePanel.open/close` | `panel_open` / `panel_close` (and `panel_fit`, `window_show`) |
| `identity.launchWebAuthFlow` (Google sign-in) | the browser, then the app's link `selectionai://auth/callback` back (`app:deep-link`) |
| `fetch` from the background | `tauri-plugin-http` (the native core), for any other origin |

## Tests

```bash
pnpm test                               # includes tests/unit/desktop-browser.test.ts (the WebExtension shim, several windows in memory)
pnpm --filter desktop test:native       # Rust: display geometry, crop and mask, storage and the secrets file
pnpm --filter desktop test:e2e          # the real app on a virtual X display (Linux: Xvfb, xdotool, ImageMagick)
```

The end-to-end tests drive the app the way a student does — the real shortcut, the real pointer and keys through the X server, a real screen capture over a window with known pixels — and read the results back: the crop's pixels, the request body a (fake) local model receives, which windows show. They cover: opening the app, the shortcut and the bar, the Screen Recording note both ways, a box (exact pixels, the panel card at the top right, the bar waiting), freeform (outside painted white), an answer streamed from a model, click-through while waiting, ✕, Escape both ways, closing the panel, the panel kept between chats (made at start, the placeholder, the same page next time), scrolling through while armed, two selections in one chat (the panel growing to fit them), the ghost, settings from the gear (the bar going, every field showing), Quit, and Open at login (the autostart entry written with `--hidden`, and removed).

On Linux the overlay draws black (a virtual display has no compositor) and the capture steps it aside; on macOS and Windows the system leaves the app's windows out instead.
