# Selection AI

Select text, a box or a page element in the browser and ask Claude or ChatGPT about exactly that. Only the selection is sent: a box as its screenshot, which the model reads, and a text selection as its text. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

The build plan's planner, which re-sends a box as extracted text, LaTeX or tables where it can, is no longer used for box selections: page text scraped from under a box garbled real layouts and duplicated the screenshot. The eval keeps a `planner` route so the idea can still be measured for Gate A.

Chrome, Edge and Firefox from one WXT codebase; Safari from week 12.

## Status

Weeks 1–2 of the build plan are done: the workspace, the shared payload schema, the provider layer (mock, local, bring-your-own-key, hosted stub), capture and cropping, the router, the selection overlay, the answer panel, the settings page, a PDF.js reader, the eval harness and CI. Weeks 3–6 add the real selectors and extractors.

| Area | State |
| --- | --- |
| Toolbar click → selection → crop → plan → streamed answer | working, Chrome and Firefox |
| Box selection | working: sends on release; optional resize-and-move handles before asking; Escape to cancel, the X to close everything |
| Text selection | working, with the captured text previewed in the panel; KaTeX/MathJax range widening lands week 3 |
| Conversation | one thread per tab: the selection pinned at the top, answer macros and a large question box, follow-ups on the same selection |
| Real answers | your own Anthropic or OpenAI key: free key check, model list, prompt caching for follow-ups, errors that say what to do |
| Element selection | next up, once this round tests clean (the chip reads "coming next") |
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

Clicking the toolbar icon arms a selection immediately — crosshair and ready to drag on the first click. A bar near the bottom of the screen carries a red X, the mode chips, the current instruction and a gear that expands the bar upward into quick settings; notices such as the PDF warning appear beneath the controls. Once you start drawing, the instruction hands over to a small tooltip anchored to the cursor reading **Escape** to cancel. The page still scrolls while a selection is armed, by wheel or keyboard, and clicking anywhere on the bar never starts a selection. Alt+Shift+S and Alt+Shift+A arm box or text directly.

Letting go of a box sends it straight to the panel, in every mode. Options → *Adjust a box before asking* keeps it on screen with eight handles instead: drag an edge or corner to resize, drag inside to move, drag outside to start over, then press **Enter**, double-click the box or click **Ask**. Escape cancels the selection; the X also closes the answer panel.

The answer panel opens once the selection is made, so it never narrows the page while you are still choosing what to select; Options → *Open the answer panel* can open it on the toolbar click instead. The selection is pinned to the top of the panel, labelled Box or Text, exactly as the model receives it. Below the conversation sit the answer macros — Explain, Hint and Check to start with — and a large question box holding the short default prompt. Enter or **Send** asks what is in the box; a macro puts its own prompt in the box and sends it. Macros and the default prompt are yours to rename and rewrite in Options. Every question after the first is a follow-up on the same selection. Each tab has its own conversation; switch tabs and the panel switches with you.

A box is clamped to the visible viewport, because `captureVisibleTab` can only return what is on screen; drag against an edge and the bar says so, and the wheel is ignored for the duration of a drag so the crop always matches what was framed. Selecting across the fold needs scroll-and-stitch capture, which is not built.

One place scrolling cannot work is the browser's own PDF viewer. That page is a plugin in an `<embed>`: it exposes no scrollable element to forward the wheel to, and it swallows mouse events, which is the only reason the drag surface has to cover the viewport there at all. On a PDF you get the drag or the wheel, not both, and the bar says so while offering the reader — where everything works.

On a PDF opened in the browser's own viewer only box selection is possible, because the text lives inside a plugin the extension cannot read. Selection AI says so and offers to reopen the file in its own PDF.js reader, where the text is real DOM and all modes work. Local files need *Allow access to file URLs* turned on for the extension in `chrome://extensions`.

The default provider is `mock`, which replays recorded answers and otherwise streams a placeholder — no network, no spend.

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

Rules that keep spend near zero: develop against `mock`; every paid answer is written into the cache by payload hash, so reruns replay for free; planner or prompt changes run the eval on `mock` and `local` first, and the paid batch eval runs weekly and before each gate.

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
│   ├── entrypoints/    background, content/ (overlay, bar, select-*, scroll), reader/, sidepanel/, options/
│   ├── extract/        visible.ts (math, table, code land weeks 4–5)
│   ├── lib/            planner, capture, router, cache, storage, threads, messages, render, pdf-detect, selection-controller, providers/
│   └── ui/             Panel, Selection, Answer, WhatIRead
├── shared/             payload.ts (types), prompts.ts (mode prompts) — one schema for all three packages
├── worker/             Cloudflare Worker for hosted plans (week 9)
├── eval/               run, batch, score, crops, problems/
├── tests/              unit/ (Vitest + jsdom), e2e/ (Playwright), fixtures/pages/
└── .github/workflows/  ci.yml, release.yml
```

Three rules hold the design together. Page-touching code lives in the content script; anything holding a key or making a network call lives in the background. Every provider speaks one OpenAI-compatible message shape, converted to the Anthropic Messages API only at the edge in `providers/byok.ts`. And `shared/payload.ts` is the single schema the extension, the Worker and the eval scripts all build against.

Four browser rules are worth knowing before changing the toolbar flow. A full-screen drag surface swallows the wheel, so the overlay forwards it to whatever is scrollable under the pointer — in the reader that is a container, not the window — and it never takes keyboard focus, which is what leaves arrows and space working. Escape is caught on `document` in capture and never needed focus. `sidePanel.open()` needs a live user gesture, and Chromium really does enforce it, so the panel opens on the gesture that commits the selection — the release, or the Enter or Ask that confirms an adjusted box — or on the toolbar click when that setting is on, with a one-click toast on the page as the last resort. Closing uses `sidePanel.close()` (Chrome 141+), and the panel also closes its own window when asked, for browsers without it. Conversations live in `storage.session`, not in the service worker, because an idle MV3 worker is torn down after about 30 seconds; the background is the only writer, streams each answer into the thread, and the panel just renders it. Chrome will not inject a content script into an extension page, so the reader runs `lib/selection-controller.ts` itself and the background routes to it by a tab registry rather than by URL — `tabs.get` does not reveal a URL without the `tabs` permission. And pdf.js 6 calls `Map.getOrInsertComputed`, so the reader imports the legacy build to keep working on the browsers students actually run.

## Privacy and permissions

The manifest asks for `activeTab`, `scripting`, `storage` and `sidePanel` — no host permissions, because the content script is injected only when you invoke it. Nothing is sent until you ask; only the selection is sent, never the whole page. The extension ships no API key and loads no code from a server at runtime. A tab's selection and conversation are kept in `storage.session`, which lives in memory, is unreadable from web pages, is dropped when the tab closes, and clears when the browser quits; nothing is written to disk. Blocked sites (Options) turn the shortcut off entirely for hostnames you list.

Calls to Anthropic and OpenAI go from the background with no host permission, as ordinary CORS requests: Anthropic allows its documented headers from any origin (checked against the live API), so the extension sends only those — a custom header would trigger a preflight the vendor could refuse. Model answers are sanitized, links open in a new tab, and images in answers are not rendered at all, because a page can try to steer the model into emitting a URL that carries data out.

## Next

The next round is the full settings pass: every section of Options fleshed out, now that macros and keys are in place. Then element selection, pulled forward from week 4: hover to highlight via `elementFromPoint`, click to pick, arrow keys to widen to the parent, which turns on the third mode chip. Then the rest of week 3 — widening a text range to whole KaTeX or MathJax expressions, and Option-drag to subtract regions from a box — and the hosted gateway (week 9), so students never need a key of their own.
