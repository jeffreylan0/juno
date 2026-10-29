# Juno, the app

The developer's guide to the app: what it does, how to run it, how it is built and tested. One key, a bar, a panel and chats, over anything on screen: Preview, Acrobat, PowerPoint, Zoom, any browser. A [Tauri 2](https://tauri.app) app, Mac first, then Windows (see the plan, *Juno desktop app*).

## What works today

The plan's spike and its *Box, Freeform and the panel on Mac* phase, with accounts and plans, built and tested on Linux (a development target only) and built for the real macOS and Windows system APIs. The product owner runs it on a Mac and testers on Macs and Windows; the checklist below is what to try.

| Area | State |
| --- | --- |
| Option+Shift+S (Alt+Shift+S on Windows), anywhere | global shortcut, no permission. Clicking the menu bar (tray) icon, or opening the app (again), does the same; right-clicking the icon opens a small menu (Select, Settings…, Quit). If another app holds the key, the bar says so once and Settings explains it |
| The bar | one quiet dark row in the manner of Claude's quick entry: ✕, the modes in the middle, then chats (opens the panel on its list of chats), the ghost and the gear. While the panel is open those three leave the bar (the panel has them) and the bar is just ✕ and the modes, evenly padded. In a transparent overlay over the whole display under the pointer, opening from its middle, **always armed in Box** (the mode is not remembered), with the screen dimmed a little while a selection is armed; small tooltips come up after a moment, and what to do next is said by the pointer; above full-screen apps and on every Space (macOS); the shortcut moves it to the display under the pointer. Where it sits is Settings → Selecting → *Where the bar and the panel go*: a 3×3 grid of the screen, the bar at the outer edge of the part picked (bottom centre to start), kept clear of the Dock, menu bar and taskbar |
| Sending | as the setting says (*After drawing a selection*): at once, or once ↑ on the bar (or Enter) is pressed, after adjusting a box or redrawing an outline |
| Screen Recording (macOS) | until it is allowed, the bar comes up with nothing armed and a note under its row: *Turn on Screen Recording* (the system's prompt, then System Settings) or *Not now* (select anyway); once asked, the note offers *Restart* |
| Box, Freeform | drawn on the overlay page (selection/); the selection is captured natively and cropped (and masked) natively: ScreenCaptureKit on macOS 14+ with the app's own windows filtered out, GDI on Windows with the app's windows excluded by display affinity for that one capture only, so screen recordings, screen sharing and remote desktops show the app as usual |
| While the bar waits | clicks go through to the app beneath everywhere but on the bar and its tooltips |
| Scrolling while armed | the wheel (or trackpad) scrolls the app beneath, under the dim, which stays put; the overlay lets the pointer through until it moves, then takes it back to select. Not while drawing or adjusting (the selection is pinned to the screen). The overlay page itself never scrolls or bounces, which is what made the dim flash |
| Panel | a card like the bar, on the selection's display where Settings → Selecting puts it (top right to start; the same 3×3 grid, the panel in the part's corner or side), floating above other apps. On macOS a real window with its title bar hidden, so the system rounds it and draws its shadow; its top bar drags it (✕ first, then the chats menu); its content rises in, and it goes at once (fading its content out left the empty window on screen for a moment). Text at the system's sizes (13 px on macOS, 14 px on Windows). Notices (no AI picked yet, no key, …) float over the end of the chat and go by themselves after 9 seconds, a ring round their ✕ running down meanwhile (pointing at one holds it); a new chat, or the panel showing again, brings them back. **Made when the app starts and kept**, hidden between chats, so it shows the moment a selection is made, with a placeholder for the selection until the screenshot is in. It opens 72% of the display tall and grows with its chat, smoothly (an eased 180 ms resize in the native core), away from the edge it was placed at, until it reaches the screen's edge. Resized by hand, it keeps that size from then on (Settings → Selecting shows it, with *Let it grow with the chat again*). Questions are rounded bubbles with copy, and edit and retry on the latest one; answers stream out at an even pace and have a copy button; the view follows the answer unless the student scrolls up. ⌘⇧O (Ctrl+Shift+O) finishes the chat and brings the bar up for the next. Its ✕ finishes the chat |
| Chats, temporary chats, macros, model picker, answers | one chat at a time (one panel); macros Explain, Hint, Check and Answer to start; a chat is named after the window its first selection was made over, without the app's name or counters that change from step to step ("Task 10 of 13 - Quiz 2.1 | Stemble — Mozilla Firefox" is "Quiz 2.1 \| Stemble"); with Settings → Chats & privacy → *Start every chat as temporary*, each new chat starts with the ghost on (`current.ts`). One model picker (`src/ui/ModelPicker.tsx`), beside Send and in Settings → Answers, writing the same settings: *Plan* (each model with the answers it has left this month), *API key* (Auto and the models, for the key there is), *Local model*; what isn't set up is greyed, and with nothing set up the panel shows a yellow hazard and *Set up required* instead |
| First run | once, the intro (`src/settings/Intro.tsx`, CSS only, `settings.introSeen`): a selection drawn in a viewfinder, a shutter blink, the mark and the name, then *Sign up* and *Sign in* or on without an account. Then the setup instead of the bar (`src/settings/Setup.tsx`): who answers (in a build with accounts, *Your plan* first, for hosted answers; an Anthropic or OpenAI API key; a local model; settings offer the same, in the same order), then Screen Recording on macOS; *Start using Juno* puts the bar up. Until something is picked, asking says to pick who answers |
| Who answers | your own Anthropic or OpenAI key, a local model, hosted answers — every request goes out through the native core, so no browser CORS rule applies, and only from the two pages that need it, the core and settings (`capabilities/net.json`; the bar and the panel, which show what others wrote, reach nothing), to the addresses its allowlist names: any `https://` address, and plain HTTP only to this computer (`localhost`, `127.0.0.1`) or a `.local` name. A local model on another computer needs one of those |
| Web search | the globe beside the macros (`ui/Panel.tsx`), on or off for each chat and kept with it (`chat:search`, `Chat.search`), a new chat starting as Settings → *Asking* says (`searchByDefault`, off); hidden for a local model (`canSearch`). A question asked with it on (auto-sent ones too) carries `search` (`AskRequest.search`; kept on the question, so *ask again* searches again): with a key, Anthropic gets its web search tool and OpenAI its own, from its index only (`shared/vendors.ts`, at most 3 searches); a plan's request tells the Worker, which takes the searches with the answer, up front, and gives back those not made. Both answers are read by one module the app and the Worker share (`shared/vendors.ts`): text, a search beginning (*Searching the web…* under the answer), Claude's citations as numbered links after what they cite, and the sources, numbered, at the end. OpenAI is asked through its Responses API (`/v1/responses`, the one OpenAI path `vault.rs` allows) |
| Rich answers | `lib/blocks/`: an answer's ```` ```plot ````, `chart`, `diagram`, `form` and `slides` blocks hold JSON (the format is in `shared/prompts.ts`), drawn after DOMPurify by DOM calls only: SVG graphs (`graphs.ts`; functions read by `expr.ts`, a parser that evaluates nothing it doesn't know), layered diagrams (`diagram.ts`), forms (drawn once the answer is all there) whose *Send* raises `juno:ask` for the panel to ask with (cancelled, and the form left as it was, when it can't ask now), slides with tabs; wide tables scroll. A block still arriving shows a placeholder; one that can't be drawn stays code. Maths is never read inside code (`render.ts`) |
| Opened elsewhere | when Juno opens a page in the browser (Google sign-in, billing, a link) or System Settings, the panel and settings show *Esc to close* at their top left for 4 seconds (`card.ts`, `juno:opened-elsewhere` from `platform/links.ts` and `Permissions.tsx`): they stay on top, and Escape puts them away |
| API keys | kept by the native core where no page can read them (`src-tauri/src/vault.rs`): Settings puts a key in (`key_set`); the core tells from its prefix whose it is (`sk-ant-` Anthropic, `sk-` OpenAI; admin keys refused) and keeps it for that company only, and pages learn only whose it is and its last four characters (`key_status`); the storage commands never read, write or announce `keys`. The core asks through `vendor_fetch`, which adds the key and sends only to asking or listing models at `api.anthropic.com` or `api.openai.com`, over HTTPS, following no redirect; the answer streams back over a channel. Anthropic is also sent `anthropic-beta: server-side-fallback-2026-07-01`, so a question one model's safeguards decline can be answered by another in the same request (`fallbacks: "default"` on Sonnet, Opus and Fable, `lib/providers/byok.ts`) |
| Native commands | every page can invoke every command, so the ones that matter check which window is asking: only the core takes a screenshot (only while the bar is up) and sends with a key; only Settings puts a key in or removes one, listens for Google's sign-in (`auth_listen`), or turns Open at login on or off; the overlay never sees the account session (`lib.rs`, SECURITY.md) |
| Settings | in the same palette, as a card (a real window, as the panel) in the middle of the screen, at one size: not resizable or maximizable, so never full screen, zoomed or filling the screen when dragged to its edge. Made hidden at start and kept, like the panel, so it is on screen the moment it is asked for (from the bar's gear it took seconds when each opening made a new window); closing hides it and starts its page afresh. It opens only when asked for (the gear, the icon's menu): bringing the bar up hides it, so a click on the menu bar icon never brings back settings left open. Above other windows, the panel included. Once it is on screen the bar and the dim go (the chat carries on; the shortcut brings the bar back). At the top a dashboard (`Dashboard.tsx`): the account (the picture, name, email, the plan in bold with when it renews or ends, *Manage billing* and *Sign out*; for a guest, *Sign up* and *Sign in* with the line *Unlock hosted answers and cloud storage.* until one is pressed, the plan *Free* or *Plus* once unlocked, and the unlock), then *Usage*: an animated horseshoe of the month's hosted answers left, with the answers the picked model has left in its middle (`answersLeft`, `shared/models.ts`); without a plan, this month's answers (counted on this computer, `lib/usage.ts`); and *You're using your plan / API key / local model*; then the settings, most used first, each with a line saying what it is for, with a menu of them at the side that fades in once the dashboard has scrolled away. The app's shortcut, where the bar and the panel go, the colour theme, updates, and a Permissions section on macOS (Screen Recording: status, *Open System Settings*, *Restart*, and what the app does and does not ask for) |
| Permissions | **Screen Recording only**, on macOS (Windows asks for nothing). No keychain, no accessibility access, no microphone, no input monitoring. macOS names the switch "Screen & System Audio Recording"; the app records no audio |
| Extras | every theme but Ember (five: Ember, Ocean, Forest, Lavender, High contrast), the bar's and panel's places, and more than two macros (`src/lib/extras.ts`): open with Plus (or a plan given by hand) or the unlock bought without an account (`src/lib/account/unlock.ts`, `worker/src/unlock.ts`), which holds on the computer that bought it only: the app sends its computer's id (a salted SHA-256 of the system's machine id: `src-tauri/src/device.rs`), and the Worker signs a license for that id alone (ECDSA P-256), which the app checks with the public half built into it (`WXT_UNLOCK_KEY`); *Restore* asks for it again after a reinstall. In a build without accounts, always open. Closed, settings show them greyed, with why and a white button to the plan laid over them (`Locked`, Options.tsx), and the pages act on the defaults (`withinPlan`) while keeping what was chosen |
| Notices | in the panel, they go by themselves after 5 seconds; a chat deleted by the chat limit is said once per run; Settings → Chats & privacy → *Notices in the panel* turns them off, and the first notice ever links there |
| Quit | Settings → Juno → *Quit Juno*, ⌘Q in the panel or settings, or the menu bar icon's right-click menu |
| Themes | Settings → Appearance: *Light or dark* (light, dark, or the system's; `src/theme.ts` sets `data-scheme` on each page, which the stylesheets key their dark palette on) and five colour themes (Ember, the default and the stylesheets' own palette, then Ocean, Forest, Lavender, High contrast), each a light and a dark palette, for the panel, settings and the bar (always dark). Themes are data (`src/lib/themes.ts`), so marketplace themes can be added later; every palette is checked for contrast (tests/unit/themes.test.ts) |
| Updates | as Discord does: a look at start and every 6 hours, the download in the background, the install once nothing of the app is on screen, then a restart into the menu bar (no bar pops up). Settings → Juno → *Update automatically* (on to start) and *Check now* (`src-tauri/src/updates.rs`). Off in a build without the update key; see *Updates* below |
| Open at login | Settings → Juno, off until turned on: the app starts in the menu bar only (`--hidden`). No permission: a launch agent in `~/Library/LaunchAgents` on macOS (the system may say a background item was added), the user's Run key on Windows |
| Storage | chats in JSON files, screenshots as image files, under the app's data folder (`~/Library/Application Support/com.humanbn.juno` on macOS); temporary chats in memory only; for an account with cloud storage, chats in the account too unless kept on this computer only (the default for a new install; signing out then takes them off the computer after a last sync, with syncing held until the session is gone: `ChatSync.signOut`); API keys and the account session in one file only your account can read (`secrets.json`, mode 0600; on Windows also encrypted for the user with DPAPI). Not the keychain: macOS ties a keychain item to the exact build that made it, so each new build asked for the keychain password, and once refused, asked at every read |
| Accounts and plans | built in when the build has the variables (below): *Sign up* (a name, then an emailed code; it makes the account) and *Sign in* (an emailed code, for an account there is), each with *Continue with Google* below the email address, and a countdown on *Send code* until another may be sent. Google needs the app's own Google client (`WXT_GOOGLE_CLIENT_ID`; a build without it says so when it is pressed, and the release workflow warns): Google's page names the app, comes back to a one-time listener on 127.0.0.1 (`src-tauri/src/oauth.rs`, RFC 8252, PKCE, state and nonce), the Worker trades the code for Google's ID token (`worker/src/google.ts`, which holds the client secret) and Supabase signs in with that. No link scheme is registered. Plans, Stripe checkout and the billing portal open in the browser too. Setup: `supabase/README.md` |
| Escape | closes all of Juno, as ✕ does: the bar and the panel go and the chat is finished, whether the bar waits, is armed, or a selection is being drawn. In the panel or settings it is taken before anything on the page hears it (`card.ts`), so a chat menu or an edit open there closes with everything else, settings too (`app:escape`, core/main.ts). *While the bar waits* it works only when the bar has the keyboard (after clicking it), since the app does not take Escape from the app you are working in |
| Drawing a selection | only the drawing shows: the bar fades out and the panel steps aside (hidden without giving up the keyboard: `panel_close` with `aside`), and both are back the moment it is made (`selection:drawing`, core/main.ts) |

## Running it

On a Mac (macOS 14 or later), once:

```bash
xcode-select --install                                   # the compilers
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # Rust
pnpm install
```

Then:

```bash
pnpm dev                  # the app with live reload (Vite on :5180)
pnpm build                # a release .app and .dmg in desktop/src-tauri/target/release/bundle
```

The app lives in the menu bar, with no Dock icon from the moment it starts (`LSUIElement` in `src-tauri/Info.plist`). Opening it brings the bar straight up (`--hidden` starts it without, for starting at login). The first time, the bar asks for **Screen Recording**: *Turn on Screen Recording*, switch *Juno* on in System Settings → Privacy & Security → Screen & System Audio Recording, then press *Restart* on the bar (macOS applies the switch to a fresh process only).

**Try the app's permissions with `pnpm app`, not `pnpm dev`.** `dev` runs a bare binary from your terminal, so macOS asks on behalf of whatever started it ("Visual Studio Code is requesting to bypass the system private window picker…") and would give *that* app Screen Recording. Don't allow it; if you did, switch the editor off again in System Settings. `app` builds a real (debug) `Juno.app` and opens it, so the prompt names Juno and the permission is the app's alone. Signed ad hoc, each rebuild is a new app to macOS and it asks again; set `APPLE_SIGNING_IDENTITY` to your Apple Development certificate and the permission survives rebuilds.

The app is Juno, bundle id `com.humanbn.juno`. Builds before the rename were *Selection AI* (`org.humanbn.selectionai`): Juno's first start moves their settings, keys, chats and screenshots into its own folder (`store::adopt_earlier_store`), but to macOS it is a new app, so Screen Recording is asked for again and the old *Selection AI* entry in that list can be removed. Remove the old app too (turn its Open at login off first). Earlier still, keys were kept in the keychain under "Selection AI"; the old items can be deleted in Keychain Access.

Accounts and hosted answers come from `.env.local` at the root of the repository (`WXT_SUPABASE_URL`, `WXT_SUPABASE_KEY`, `WXT_GATEWAY_URL`, and `WXT_GOOGLE_CLIENT_ID` for Google sign-in in the app's name; the names are older than the app); the GitHub builds take them from Actions variables (`supabase/README.md`, step 7).

### When it misbehaves on someone else's computer

The app keeps a short log of its own steps and errors: each start, each window's page loading, the first bar shown, page errors, a panic, or a failed start (on Windows also said in a message box). Never what was asked, the screen or a key. It is `juno.log` in `~/Library/Logs/Juno/` on macOS, `%LOCALAPPDATA%\com.humanbn.juno\` on Windows (`src-tauri/src/diag.rs`). CI opens the Windows build the same way a student does and prints that log, the app's windows and what changed on screen (`scripts/smoke-windows.ps1`), and fails unless the bar came up.

### Test builds for other people

The *Test build* workflow (`.github/workflows/desktop-release.yml`) builds the installers on GitHub's Macs and Windows machines:

- a universal `.dmg`, signed ad hoc;
- a Windows setup `.exe`.

To publish them as a prerelease on the repository's Releases page, go to *Actions → Test build → Run workflow*, or push a tag (`git tag desktop-v0.2.0 && git push origin desktop-v0.2.0`); a `desktop-vX.Y.Z` tag sets the app's version to X.Y.Z. [`TESTERS.md`](../TESTERS.md) is the release notes: installing, choosing who answers, what to look for, and how to report.

They have accounts when the repository's Actions variables hold the Supabase project and the Worker (`supabase/README.md`, step 7; the run's summary says whether they were there). Testers can also bring their own key or a local model. To share a key with testers:

1. Make it in its own Anthropic workspace with a monthly spend limit.
2. Send it privately.
3. Revoke it when testing ends.

Never put a key in a build.

Because the builds aren't signed with a Developer ID, macOS asks testers to *Open Anyway* once per build and to allow Screen Recording again after each update. Windows SmartScreen shows *More info → Run anyway*. An Apple Developer ID ($99 a year) with notarization removes the macOS steps: set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` as the build's environment, and Tauri signs and notarizes.

### Updates

Installed copies update themselves from the repository's Releases (Tauri's updater): each looks at `latest.json` in the release called `updates` a minute after it starts and every 6 hours, and installs a newer version only if it carries a valid signature from the update key, once Juno isn't in use. The key's private half never reaches a build, where every package's build code runs: the builds leave the update files unsigned, and the *Test build* workflow's `sign` job signs them with the Tauri CLI alone, under the `release` environment, then checks every signature against the public half the builds carry (each build records the one it was made with) before anything is published.

Once:

1. Make the key, on your own computer: `pnpm --filter desktop tauri signer generate -w ~/.tauri/juno-updates.key`, with a password. Keep the key file and the password in your password manager: lose them, and installed copies can never update again.
2. GitHub → Settings → Environments → *New environment*, named `release`:
   - *Deployment branches and tags* → *Selected branches and tags* → add a tag rule, `desktop-v*`.
   - *Required reviewers* → yourself: every release then waits for your approval before the key is used.
   - *Environment secrets*: `TAURI_SIGNING_PRIVATE_KEY` (the contents of `juno-updates.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
   - If these two were added earlier as repository secrets (Settings → Secrets and variables → Actions → *Secrets*), delete them there: any workflow on any pushed branch can read a repository secret.
3. Settings → Secrets and variables → Actions → *Variables*: `TAURI_UPDATER_PUBKEY`, the contents of `juno-updates.key.pub` (or put it in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` and commit it). It is public on purpose, and it is what turns updating on in a build.
4. Settings → Rules → Rulesets → *New tag ruleset*: target `desktop-v*`, restrict creations, updates and deletions, with only yourself allowed to bypass. Only you can then start a release.

Each update:

1. Merge what ships into `main`.
2. Tag it with a higher version than the last, and push the tag: `git fetch origin main && git tag desktop-v0.2.0 origin/main && git push origin desktop-v0.2.0`. (Not a release made on GitHub's Releases page: the workflow makes the release itself.)
3. Actions → *Test build* → the run for that tag: the Mac and Windows builds take about 15 minutes, then *Sign the update files* waits. Open it → *Review deployments* → tick `release` → *Approve and deploy*.
4. It signs, checks the signatures, publishes the prerelease `desktop-v0.2.0` (installers, update files, `SHA256SUMS`) and points `latest.json` in `updates` at it. Installed copies take it within 6 hours; Settings → Juno → *Check now* looks at once.

**If *Sign the update files* fails** with "signed with update key A, but the builds carry the public half of key B", the private key the release signs with and the public half the builds were made with are not one pair. Each key has an id, which its `.pub` names on its first line (`base64 -d < ~/.tauri/juno-updates.key.pub`, or the `TAURI_UPDATER_PUBKEY` variable's value through `base64 -d`); the error names both. Then:

- **Your key file's `.pub` is key B** (the builds are right): the release signed with another private key. Put the contents of `juno-updates.key` in the `release` environment's `TAURI_SIGNING_PRIVATE_KEY`, with its password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and delete any repository secret of either name (Settings → Secrets and variables → Actions → *Secrets*), which a job uses when its environment has none. Then the run → *Re-run failed jobs*: only the signing runs again, and the builds stay as they are.
- **Your key file is key A, or B's private half is lost**: set `TAURI_UPDATER_PUBKEY` to the contents of the `.pub` that goes with the private key in the environment, and push a new tag with a higher version. The builds carry the public half they were made with, so they have to be made again; re-running only the signing would be checked against the old one and fail again.
- **Neither file is to hand**: make a new pair (step 1) and set both halves from it (steps 2 and 3), then push a new tag. Copies installed from builds that carried the old public half reinstall once.

A tag whose key or public half is missing still builds and publishes the installers, with no update, and the run says so. The releases must stay public: installed copies download without signing in. A version lower than the installed one is never installed. Builds made before step 3 have no key, so testers reinstall once; every later build updates itself. Until the Mac app is signed with a Developer ID, each update is a new app to macOS, which asks for Screen Recording again after it (the bar says so); a Developer ID ends that.

## Spike checklist (the plan's first gate)

*Gate: overlay and capture work across displays and over full-screen apps, or the overlay goes native.*

1. Open the app the first time: the setup comes up (who answers, then Screen Recording); *Start using Juno* puts the bar up from its middle at the bottom of the screen. After that, Option+Shift+S over Preview: the screen dims a little, the bar comes up with Box armed, the cursor is a crosshair everywhere, and resting it a moment shows *Drag to select* beside it.
2. Drag a box over part of a PDF: the panel comes in as a card at the top right, the selection shows in it, and Explain answers. The panel grows with the answer and stops at the bottom of the screen.
3. The bar waits: clicking and scrolling in Preview work everywhere except on the bar.
4. Freeform: the panel shows only the inside of the shape; while drawing, the bar and the panel are out of sight; ✕ or Escape (at any point, or in the panel) closes bar and panel.
5. Full screen: put Preview (or Keynote) in full screen, press the shortcut: the bar comes up over it, a box works, the panel appears next to it without leaving the full-screen Space.
6. Two displays (ideally Retina + standard, one left of the main display): with the pointer on each, the shortcut brings the bar to that display and a box there is cropped exactly (no offset, no scaling).
7. Stage Manager on: the same.
8. Screen Recording off (System Settings): the shortcut brings the bar up with the note under it; *Turn on Screen Recording* opens System Settings, and the next shortcut offers *Restart*.
9. Switching modes, opening the panel or settings, finishing a selection: no flash anywhere (the dim fades out; windows appear only once drawn).
10. Click the menu bar icon: the bar comes up at once. Right-click it: Select, Settings…, Quit. No keychain prompt, ever; a key saved in Settings shows only as its last four characters and works for asking.
11. Box armed, scroll with the trackpad over Preview: the page scrolls under the dim, which never flickers; moving the pointer and dragging selects as usual.
12. A selection: the panel is there at once with a shimmering placeholder, then the screenshot. Its corners and shadow look like any Mac window's, with no halo. The gear opens settings and the bar and dim go; the macro rows show name, prompt and ✕ side by side.
13. With the bar up, the gear: settings are on screen at once (they are kept, hidden, from the start), then the bar and dim go.
14. In a build with accounts (`supabase/README.md`): Settings → *Sign in* → *Continue with Google* opens the browser on Google's page, naming Juno; after signing in the tab says to go back to Juno, and settings are signed in. Then click the menu bar icon with settings open: settings go, and don't come back with the next click.
15. With the panel open, ✕ on the bar: the bar goes as it is, without first showing the chats, ghost and gear again. With the panel open the bar's ✕ and modes sit evenly in it.
16. An answer comes out evenly rather than in bursts, and the panel grows smoothly with it. Scroll up while it streams, even the smallest trackpad nudge: the panel stays put; scroll back to the end and it follows again.
17. Point at a question: copy; on the latest, edit (ask it reworded) and retry (ask it again). ⌘⇧O starts a new chat.
18. Settings → Selecting → *Where the bar and the panel go*: pick other squares; the next shortcut puts the bar there, and the next panel opens there. Resize the panel by hand, finish the chat, select again: it opens at that size.
19. With the panel open (by a selection, or the bar's chats button), the bar's chats, ghost and gear fold away smoothly, and come back the same way.
20. Settings → Appearance: each theme recolours the panel, settings and the bar at once; *Light or dark* switches the panel and settings at once, and *System* follows the Mac's appearance as it changes.
21. Settings → Juno shows the version and, in a build with the update key, *Update automatically* and *Check now*.

Anything that fails in 1, 3, 5 or 6 is the spike's question: whether the transparent overlay holds up, or becomes a small native window.

## How it is built

A small native core does only what the system must; web code runs everything else in four windows.

```
desktop/
├── src-tauri/            the native core (Rust)
│   ├── src/lib.rs        commands, the shortcut, the menu bar icon, app setup
│   ├── src/wm.rs         the four windows; click-through polling for the waiting bar; the panel's eased resize
│   ├── src/geometry.rs   displays, the pointer, the system bars, where the bar and the panel go (mixed scales, negative coordinates)
│   ├── src/capture/      a display's screenshot without our windows: macos.rs (ScreenCaptureKit), windows.rs (GDI), linux.rs (X11, tests); the window a selection was made over
│   ├── src/crop.rs       crop, freeform mask, downscale to 1568 px, PNG
│   ├── src/store.rs      storage.local/session, screenshot files, the private secrets file (DPAPI on Windows)
│   ├── src/vault.rs      the API keys: whose each is (from the key), kept from every page, sent by the core only to asking and listing models at their own company
│   ├── src/oauth.rs      Google's sign-in coming back: a one-time listener on 127.0.0.1
│   ├── src/updates.rs    updating itself: look, download, install when not in use, restart hidden
│   └── src/testhook.rs   the end-to-end tests' hook (debug builds with --features test-hook only)
├── src/
│   ├── core/             the hidden core window: shows the bar and the panel, takes the screenshot, keeps the chat in step
│   ├── overlay/          the overlay window: the selection flow (lib/selection-controller.ts), which parts take the pointer, the bar's notes
│   ├── panel/            the panel window, and fitting it to its chat (fit.ts)
│   ├── settings/         the settings window (Options.tsx and its sections; Setup.tsx, the first-run setup)
│   ├── selection/        the bar, the overlay's drawing surface, the Box and Freeform selectors
│   ├── lib/              the chat engine (engine.ts: the write queue, answers, the cloud copy, the connection status), chats,
│   │                     the current chat, screenshots, settings, the planner, providers/, account/, rendering, blocks/ (drawn answers)
│   ├── ui/               the panel's components (Panel, Answer, Selection, ChatMenu, ModelPicker, Notices)
│   ├── platform/         a WebExtension-shaped `browser` over the native core, files for screenshots, network, links, the key vault (vault.ts)
│   ├── card.ts           the panel and settings as cards: drag by the top bar (the native core starts it: wm.rs `drag`), the entrance (`card:enter` for the kept panel), settings shown only once drawn
│   ├── theme.ts          each page following the colour theme (lib/themes.ts)
│   └── brand.ts          what the app calls itself
├── web/                  the four pages (and a fixture page for the tests)
├── tests/e2e/            the app end to end, on a virtual display
└── vite.config.ts        the four pages, the `@/` and `@shared/` aliases, harden-libs.ts
```

The code began as a browser extension, and its pages still talk to a WebExtension-shaped `browser` (`platform/browser.ts`), which the native core stands behind:

| `browser` | In the app |
| --- | --- |
| `storage.local` | JSON files under `<app data>/store/local`, one per key; `account` in `<app data>/store/secrets.json`, private to the user, with the API keys, which no page reaches (`vault.rs`) |
| `storage.session` | memory in the native core, shared by the windows |
| screenshots (`lib/images.ts`) | files under `<app data>/store/images/<chat id>/` |
| `runtime.sendMessage` / `onMessage` | Tauri events to the core window, which answers |
| `runtime.connect` (the panel's port) | an event-based port; the panel is only ever hidden, so it disconnects only if its page goes away |
| `runtime.openOptionsPage(section)` | `settings_open` |
| `identity.launchLoopbackFlow` (Google sign-in) | `auth_listen` (a one-time listener on 127.0.0.1), the browser, then `auth:returned` with what came back to that port |
| `commands.getAll` | the shortcut the app registered |
| `fetch` from the core and settings | `tauri-plugin-http` (the native core), for any other origin |
| `runtime.deviceId` | this computer's id for the unlock (`app_info`, `device.rs`) |

Capture, the windows and the keys are commands of their own: `capture_selection` (native capture, crop and mask), `panel_open` / `panel_close` / `panel_fit`, `window_show` (settings' page has drawn), `key_status` / `key_set` / `key_remove` / `vendor_fetch` (vault.rs), `auth_listen` (oauth.rs).

## Tests

```bash
pnpm test               # unit tests, all against the app's own `browser` shim over a native core in memory (tests/support/fake-core.ts); desktop-browser.test.ts tests the shim itself, several windows at once
pnpm test:native        # Rust: display geometry and placement, crop and mask, storage and the secrets file, the key vault (whose key, endpoint allowlist), Google's return
pnpm test:e2e           # the real app on a virtual X display (Linux: Xvfb, xdotool, ImageMagick)
```

The end-to-end tests drive the app the way a student does — the real shortcut, the real pointer and keys through the X server, a real screen capture over a window with known pixels — and read the results back: the crop's pixels, the request body a (fake) local model receives, which windows show. They cover: the first-launch intro (once) and the first-run setup, opening the app, the shortcut and the bar, the Screen Recording note both ways, a box (exact pixels, the panel card at the top right, the bar waiting), freeform (outside painted white), an answer streamed from a model, click-through while waiting, ✕, Escape while waiting, while selecting, the bar and the panel stepping aside while a selection is drawn, Escape in the panel with the chat menu open (all of Juno closes, settings too), closing the panel, the panel kept between chats (made at start, the placeholder, the same page next time), scrolling through while armed, two selections in one chat (the panel growing to fit them), the ghost, settings from the gear (the bar going, every field showing, kept and on screen at once the next time, gone when the bar is summoned), the dashboard (a guest's profile) and the side menu, light and dark, the Ember theme by default, an API key (whose it is told from the key; no page can read it or send it elsewhere), scrolling up while an answer streams, the globe (none for a local model; a key's model starting as settings say, off for one chat), an answer's graph, diagram and form (its choice asked as the next question), *Esc to close* in the panel and settings when a page opens elsewhere, Quit, and Open at login (the autostart entry written with `--hidden`, and removed).

On Linux the overlay draws black (a virtual display has no compositor) and the capture steps it aside; on macOS and Windows the system leaves the app's windows out instead.
