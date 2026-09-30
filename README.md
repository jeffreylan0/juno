# Selection AI

Select a box, any shape, a page element or some text in the browser and ask Claude or ChatGPT about exactly that. Only the selection is sent: a box, a freeform shape or an element as its screenshot, which the model reads, and a text selection as its text. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

The build plan's planner, which re-sends a box as extracted text, LaTeX or tables where it can, is no longer used for box selections: page text scraped from under a box garbled real layouts and duplicated the screenshot. The eval keeps a `planner` route so the idea can still be measured for Gate A.

Chrome, Edge and Firefox from one WXT codebase; Safari from week 12.

## Status

Weeks 1–2 of the build plan are done: the workspace, the shared payload schema, the provider layer (mock, local, bring-your-own-key, hosted stub), capture and cropping, the router, the selection overlay, the answer panel, the settings page, a PDF.js reader, the eval harness and CI. Weeks 3–6 add the real selectors and extractors.

| Area | State |
| --- | --- |
| Shortcut icon or ⌥⇧S / Alt+Shift+S → selection → crop → streamed answer | working, Chrome and Firefox |
| Box selection | working: sends on release; optional resize-and-move handles before asking; Escape to cancel, the X to close everything |
| Freeform selection | working: draw any closed shape; the AI sees only what is inside the outline |
| Element selection | working: hover highlights a paragraph, equation, table or figure; ↑/↓ widen or narrow; click or Enter picks it |
| Text selection | working, with the captured text previewed in the panel; KaTeX/MathJax range widening lands week 3 |
| Chats | the icon brings the bar up on a tab; the panel opens with the first selection and stays open from tab to tab; ✕ (bar or panel) or Escape hides both and finishes the chat; a chat menu with search, rename and delete; temporary (ghost) chats from the bar or the panel; 10, 25, 50 or 100 chats kept on this computer |
| Settings | four sections (Answers, Asking, Selecting, Chats & privacy), only what the chosen AI needs on screen, saved as you go |
| Notices | above the macros: placeholder answers, no key, a rejected key, and "Disconnected" when the chosen AI cannot be reached |
| Real answers | your own Anthropic or OpenAI key: free key check, model picker beside the macros, prompt caching for follow-ups, errors that say what to do; temporary chats ask for the shortest retention the API allows |
| PDFs | reader with a real PDF.js text layer; all modes work there |
| Extractors (visible, math, table, code) | `extract/visible.ts` only; rest weeks 4–5 |
| Providers | mock, local (Ollama), BYOK (Anthropic + OpenAI); hosted gateway is a stub |
| Eval | 5 seed problems of 100; mock and image-only routes run |
| Worker, Stripe, Supabase | stubs with the week-9/10/11 shape |

The surfaces are deliberately unstyled beyond a block of CSS tokens at the top of `ui/panel.css`, `entrypoints/options/options.css` and `entrypoints/reader/reader.css`, plus the `--sai-*` variables the in-page bar, tooltip and toast read. Replacing those blocks re-themes everything.

## Quick start

```bash
pnpm install
cp .env.example .env.local     # PROVIDER=mock needs no keys
pnpm dev                       # Chrome with live reload
pnpm dev:firefox               # same in Firefox
```

Clicking the shortcut icon (or pressing ⌥⇧S on a Mac, Alt+Shift+S elsewhere) slides up a bar near the bottom of the screen with a selection already armed — crosshair and ready to drag on the first click. The bar carries a red X, the mode chips, the current instruction, the ghost (temporary chat) and a gear that expands the bar upward into quick settings; notices such as the PDF warning appear beneath the controls. Once you start drawing, the instruction hands over to a small tooltip anchored to the cursor reading **Escape** to cancel. The page still scrolls while a selection is armed, by wheel or keyboard, and clicking anywhere on the bar never starts a selection.

The chips switch between four modes, and the icon starts whichever was used last — it is not a setting. **Box** drags a rectangle. **Freeform** draws any closed shape; the screenshot is the shape's bounding box with everything outside the outline painted white, so a neighbouring answer key cannot leak in. **Element** highlights whatever sensible block is under the pointer — a paragraph, a whole equation (never one glyph of it), a table (never one cell), a figure — with a tag naming it; ↑ widens to the next visibly larger container, ↓ narrows back, and a click or Enter picks it without the page reacting to the click. The AI gets a screenshot snapped to the element; one taller than the screen is scrolled into view and captured from the top, and the panel says only the visible part was sent. **Text** sends the selected text itself.

The shortcut is bound to the browser's own "click the icon" command (`_execute_action`), so it behaves exactly like the icon. Alt/Option+Shift+S is the one family free in Chrome, Edge and Firefox on both Windows and Mac; every Ctrl/Cmd+Shift letter is taken by one browser or another, and Chrome silently refused the old Alt+Shift+A for text because it is Chrome's own "focus inactive dialogs". Each mode also has a command students can bind; Settings shows the live binding and a *Change…* button.

Letting go of a box sends it straight to the panel, in every mode. Options → *Adjust a box before asking* keeps it on screen with eight handles instead: drag an edge or corner to resize, drag inside to move, drag outside to start over, then press **Enter**, double-click the box or click **Ask**. Escape cancels the selection; the X also closes the answer panel.

The answer panel opens with the first selection, so it never narrows the page while you are still choosing what to select, and then stays open from tab to tab. The bar stays on the page through each selection — only the selection's own drawing is taken off for the screenshot (and the bar too, if the selection runs under it) — and the selection's outline flies off towards the panel. With *reduce motion* on, nothing animates.

The shortcut icon (or the shortcut) brings the bar up on the tab you are on. Switching to another tab takes it away, and nothing is kept for coming back: click the icon wherever you are and it is there again. After each selection it waits: nothing is armed, the page works normally, and one click on a chip starts the next selection. The first selection opens the panel and starts a chat, named after its page (click the name to rename it), and every later one joins it, whichever tab it comes from. ✕ on the bar, ✕ on the side panel, or Escape while the bar waits hides both and finishes the chat: a saved chat stays in the chat menu, a temporary one is deleted; the next click on the icon starts a new chat. Escape while selecting only stops that selection (before anything has been selected it also hides both: never mind); an Escape the page uses for itself — in a text field, closing a dialog — is left alone. The ghost, on the bar (left of the gear) or in the panel's top bar, makes the next selection start a temporary chat: never listed, kept in memory, deleted with its screenshots when it is finished, left with the ghost, or swapped for another chat. Pressed before anything is selected, it opens nothing: the panel comes with the selection, already temporary. Each question carries every selection made since the last one, so *select, select, ask* asks about both, and earlier selections go along as the conversation, so the model always has every selection in the chat; a selection can be taken back (×) until a question has carried it. The chat menu (☰, top left) has a search box that looks through titles, pages and questions, and every saved chat grouped Today / Yesterday / Previous 7 days / Older, each with rename and delete; opening one carries on selecting into it. Saved chats and their screenshots stay on this computer only; Settings → *Chats & privacy* picks how many are kept (10, 25, 50 or 100; 10 to start), the panel says so when the oldest goes, and keeping fewer than there are asks first. A selection's page is named above it only when it differs from the page the chat is named after. On a page the bar cannot go on — the browser's own pages, the extension stores, a blocked site, or a local file before *Allow access to file URLs* is on — the icon opens the panel instead, saying why. If the extension is updated or reloaded under an open page, the bar left there goes at the first click (or when you come back to the tab) and says to click the icon again.

Each selection is labelled Box, Freeform, Element or Text with the page it came from, exactly as the model receives it. Screenshots sit straight on the panel's own background — no card, frame or fill — with a hairline at the edge; a freeform shape shows only its inside, with the outline drawn on (the model gets the same area with the outside painted white, since models read transparency inconsistently). Below the chat sit any notices (yellow: placeholder answers, no key, a rejected key, or **Disconnected** when the chosen AI or local server cannot be reached, with Retry), then the answer macros — Explain, Hint and Check to start with — with the model picker on the same row (Claude Haiku 4.5, Sonnet 5.5, Opus 5.5, Fable 5.1; GPT-6 Luna, Sol, Astra; a local model; placeholder answers), and a large, empty question box. Enter or **Send** asks what is typed; a macro puts its own prompt in the box and sends it. Macros and the default prompt are yours to rename and rewrite in Options.

A box is clamped to the visible viewport, because `captureVisibleTab` can only return what is on screen; drag against an edge and the bar says so, and the wheel is ignored for the duration of a drag so the crop always matches what was framed. Selecting across the fold needs scroll-and-stitch capture, which is not built.

One place scrolling cannot work is the browser's own PDF viewer. That page is a plugin in an `<embed>`: it exposes no scrollable element to forward the wheel to, and it swallows mouse events, which is the only reason the drag surface has to cover the viewport there at all. On a PDF you get the drag or the wheel, not both, and the bar says so while offering the reader — where everything works.

On a PDF opened in the browser's own viewer only Box and Freeform work, because the text lives inside a plugin the extension cannot read. Selection AI says so and offers to reopen the file in its own PDF.js reader, where the text is real DOM and all modes work. Local files need *Allow access to file URLs* turned on for the extension in `chrome://extensions`.

The default provider is `mock`, which streams a placeholder — no network, no spend.

To get real answers, open Options (the gear in the panel), paste an Anthropic or OpenAI key under *Your API key*, press **Test key** — it lists the models the key can use and costs nothing — then **Use this key for answers**. *Automatic* picks Claude Haiku 4.5 for text and Claude Sonnet 5.5 for screenshots (GPT-6 Luna and Sol on OpenAI). Set a spend limit in the vendor's console. Errors say what to fix: a rejected key, no credit and an unknown model offer *Open settings*; a rate limit, an overload or a dropped connection offers *Try again*.

Or point at a local Ollama server:

```bash
ollama pull qwen2.5vl:7b
ollama serve                   # OpenAI-compatible on http://localhost:11434/v1
```

## Daily workflow

| Task | Command |
| --- | --- |
| Chrome with live reload | `pnpm dev` |
| Firefox | `pnpm dev:firefox` |
| Edge | `pnpm --filter extension build:edge`, then *Load unpacked* at `edge://extensions` |
| Safari (week 12) | `pnpm --filter extension build:safari`, then `xcrun safari-web-extension-converter` |
| Unit tests | `pnpm test` |
| End-to-end | `pnpm test:e2e` |
| Typecheck everything | `pnpm typecheck` |
| Worker locally | `pnpm worker:dev` |

Rules that keep spend near zero: develop against `mock`; every paid eval answer is written into `eval/cache` by payload hash, so reruns replay for free (the extension itself keeps no answer cache, so nothing outlives its chat); planner or prompt changes run the eval on `mock` and `local` first, and the paid batch eval runs weekly and before each gate.

## Eval

The eval scripts decide Gate A, so they matter more than any other non-product code.

```bash
pnpm eval:crops                              # render fixture crops (Playwright)
pnpm eval:run --route mock                   # free
pnpm eval:run --route planner,image-only --provider byok --vendor anthropic
pnpm eval:batch --model claude-haiku-4-5-20251001   # half price, ~24h window
pnpm eval:score --gate
```

Four routes are compared: `mock` (replay), `local` (Ollama), `image-only` (just the crop, the baseline) and `planner` (the planner's exact parts). **Gate A** passes when `planner` accuracy is within 2 points of `image-only`, plus 300 waitlist signups. `eval/problems/README.md` has the problem format; the set grows to 100.

## Layout

```
selection-ai/
├── extension/          WXT project: Chrome, Edge, Firefox, Safari
│   ├── brand.ts        name, description, icon wording (assets/brand/icon.svg → pnpm brand:icons)
│   ├── entrypoints/    background, content/ (overlay, bar, select-box/-freeform/-element/-text, scroll), reader/, sidepanel/, options/
│   ├── extract/        visible.ts (math, table, code land weeks 4–5)
│   ├── lib/            planner, capture, router, cache, storage, chats, current, images, status, kinds, messages, render, pdf-detect, selection-controller, providers/
│   └── ui/             Panel, Selection, ModelPicker, Answer, WhatIRead
├── shared/             payload.ts (types), prompts.ts (mode prompts) — one schema for all three packages
├── worker/             Cloudflare Worker for hosted plans (week 9)
├── eval/               run, batch, score, crops, problems/
├── tests/              unit/ (Vitest + jsdom), e2e/ (Playwright), fixtures/pages/
└── .github/workflows/  ci.yml, release.yml
```

Three rules hold the design together. Page-touching code lives in the content script; anything holding a key or making a network call lives in the background. Every provider speaks one OpenAI-compatible message shape, converted to the Anthropic Messages API only at the edge in `providers/byok.ts`. And `shared/payload.ts` is the single schema the extension, the Worker and the eval scripts all build against.

Four browser rules are worth knowing before changing the toolbar flow. A full-screen drag surface swallows the wheel, so the overlay forwards it to whatever is scrollable under the pointer — in the reader that is a container, not the window — and it never takes keyboard focus, which is what leaves arrows and space working. Escape is caught on `document` in capture and never needed focus. `sidePanel.open()` needs a live user gesture, and Chromium really does enforce it, so the panel opens on the gesture that commits the selection — the release, or the Enter or Ask that confirms an adjusted box — with a one-click toast on the page as the last resort. Closing uses `sidePanel.close()` (Chrome 141+), and the panel also closes its own window when asked, for browsers without it. Chats live in storage, not in the service worker, because an idle MV3 worker is torn down after about 30 seconds: saved chats in `storage.local` (one key each plus a small index for the menu), temporary ones in `storage.session`, and screenshots in the extension's own IndexedDB, referenced from the chat, so ten chats of screenshots never hit `storage.local`'s 10 MB. The background is the only writer and makes every chat write one at a time, so a selection landing while an answer streams is never overwritten. Which chat a window shows is `current:<windowId>` in `storage.session` (`lib/current.ts`). Each open panel holds a port to the background and pings it every 20 seconds, which keeps the worker awake while a panel is open, so its closing is always noticed; a panel that reconnects after a worker restart claims its chat back. The tab the bar is on is `bar:<windowId>` in `storage.session`, only so that `tabs.onActivated` can take it off when the student switches away (headless Chromium never marks background tabs hidden, and split view shows two at once, so page visibility cannot be the signal). The bar is built once and kept through each selection; the background answers `selection:done` as soon as `captureVisibleTab` returns and crops, saves and asks afterwards, so the bar is back to waiting almost at once. An orphaned content script (the extension reloaded under the page) throws "Extension context invalidated" synchronously from every `runtime` call, which a `.catch()` never sees, so every message goes through `send()` in `lib/messages.ts`, which checks `runtime.id` and catches; the bar notices and takes itself down. A second injection takes over from the first through WXT's context invalidation. Chrome gives extension pages `body { font-size: 75% }`, so both stylesheets set the body back to `1rem`. Chrome does not count a click inside a side panel as the activeTab gesture, which is one more reason the bar, summoned by the icon, stays the way in. Chrome will not inject a content script into an extension page, so the reader runs `lib/selection-controller.ts` itself and the background routes to it by a tab registry rather than by URL — `tabs.get` does not reveal a URL without the `tabs` permission. And pdf.js 6 calls `Map.getOrInsertComputed`, so the reader imports the legacy build to keep working on the browsers students actually run.

## Privacy and permissions

The manifest asks for `activeTab`, `scripting`, `storage` and `sidePanel`, and no host permissions at all: the content script is injected only into the tab where the icon is clicked. Nothing is sent until you ask; only the selection is sent, never the whole page. The extension ships no API key and loads no code from a server at runtime. Chats are kept on this computer only: saved chats in extension storage and their screenshots in the extension's IndexedDB, neither readable by web pages nor synced anywhere; temporary chats in memory (`storage.session`), deleted with their screenshots when finished. Settings → *Chats & privacy* → *Delete all chats* clears them. How many saved chats are kept is the student's choice (10 to 100); cloud storage is for super users, later. No answer is cached anywhere by the extension (earlier versions kept a replay cache in `storage.local`; it is cleared on update). Blocked sites (Options) turn the shortcut off entirely for hostnames you list.

Neither Anthropic nor OpenAI trains on API traffic by default (OpenAI does if the key's organization opted in to data sharing). Anthropic deletes API inputs and outputs within 30 days (longer only for usage-policy flags) and has no per-request retention setting; its prompt cache is memory-only. OpenAI keeps abuse-monitoring logs up to 30 days; every request is sent with `store: false`, and a temporary chat also asks for `prompt_cache_retention: "in_memory"`, falling back (once per model) where a model offers only the 24-hour cache. On the hosted route a temporary chat is marked `ephemeral`, and the Worker turns off AI Gateway logging and caching for it. A local model never sends anything off the computer. Settings → *Chats & privacy* → *What is sent, and what is kept* says the same in plain words.

Calls to Anthropic and OpenAI go from the background with no host permission, as ordinary CORS requests: Anthropic allows its documented headers from any origin (checked against the live API), so the extension sends only those — a custom header would trigger a preflight the vendor could refuse. Model answers are sanitized, links open in a new tab, and images in answers are not rendered at all, because a page can try to steer the model into emitting a URL that carries data out.

## Rebranding

Everything the product calls itself lives in `extension/brand.ts`: name, short name, store description, the toolbar tooltip and how copy refers to the icon ("the shortcut icon"). The manifest, page titles, the settings page and the panel read from it. The icon is drawn once, in `extension/assets/brand/icon.svg`; `pnpm brand:icons` renders it to every PNG size with the Playwright Chromium the tests already use. Keep `GECKO_ID` unchanged through any rename, or Firefox treats the renamed add-on as a new one and existing users stop getting updates.

## Next

Deferred from round 10: the chat limit as a super-user setting (fixed at 10 until plans settle), and cloud storage for chats once user management lands.

Next: the rest of week 3 — widening a text range to whole KaTeX or MathJax expressions, and Option-drag to subtract regions from a box — then privacy masking, the eval set and the store beta, and the hosted gateway (week 9), so students never need a key of their own. The project doc lists everything remaining.
