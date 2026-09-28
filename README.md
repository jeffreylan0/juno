# Selection AI

Select text, a box or a page element in the browser and ask Claude or ChatGPT about exactly that. A local planner sends each part in its cheapest exact form — text, LaTeX, a Markdown table, code — and adds a screenshot crop only where the content is visual or layout-sensitive. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

Chrome, Edge and Firefox from one WXT codebase; Safari from week 12.

## Status

Weeks 1–2 of the build plan are done: the workspace, the shared payload schema, the provider layer (mock, local, bring-your-own-key, hosted stub), capture and cropping, the router, the selection overlay, the answer panel, the settings page, a PDF.js reader, the eval harness and CI. Weeks 3–6 add the real selectors and extractors.

| Area | State |
| --- | --- |
| Toolbar click → selection → crop → plan → streamed answer | working, Chrome and Firefox |
| Box selection | working, with a control bar, cursor tooltip and Escape or the X to cancel |
| Text selection | working; KaTeX/MathJax range widening lands week 3 |
| Element selection | week 4 (the mode chip is shown disabled) |
| PDFs | reader with a real PDF.js text layer; all modes work there |
| Extractors (visible, math, table, code) | `extract/visible.ts` only; rest weeks 4–5 |
| Providers | mock, local (Ollama), BYOK (Anthropic + OpenAI); gateway is a stub |
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

Clicking the toolbar icon arms a selection immediately — crosshair and ready to drag on the first click. A bar near the bottom of the screen carries a red cancel button, the mode chips, the current instruction and a gear that expands the bar upward into quick settings; notices such as the PDF warning appear beneath the controls. Once you start drawing, the instruction hands over to a small tooltip anchored to the cursor reading **Escape** to cancel. The page still scrolls while a selection is armed, by wheel or keyboard, and clicking anywhere on the bar never starts a selection. Alt+Shift+S and Alt+Shift+A arm box or text directly.

A box is clamped to the visible viewport, because `captureVisibleTab` can only return what is on screen; drag against an edge and the bar says so, and the wheel is ignored for the duration of a drag so the crop always matches what was framed. Selecting across the fold needs scroll-and-stitch capture, which is not built.

One place scrolling cannot work is the browser's own PDF viewer. That page is a plugin in an `<embed>`: it exposes no scrollable element to forward the wheel to, and it swallows mouse events, which is the only reason the drag surface has to cover the viewport there at all. On a PDF you get the drag or the wheel, not both, and the bar says so while offering the reader — where everything works.

On a PDF opened in the browser's own viewer only box selection is possible, because the text lives inside a plugin the extension cannot read. Selection AI says so and offers to reopen the file in its own PDF.js reader, where the text is real DOM and all modes work. Local files need *Allow access to file URLs* turned on for the extension in `chrome://extensions`.

The default provider is `mock`, which replays recorded answers and otherwise streams a placeholder — no network, no spend.

To use a real model, open Options and either paste an API key (provider: *My own API key*) or point at a local Ollama server:

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
│   ├── lib/            planner, capture, router, cache, storage, messages, render, pdf-detect, selection-controller, providers/
│   └── ui/             Panel, Tray, Preview, Answer, WhatIRead
├── shared/             payload.ts (types), prompts.ts (mode prompts) — one schema for all three packages
├── worker/             Cloudflare Worker for hosted plans (week 9)
├── eval/               run, batch, score, crops, problems/
├── tests/              unit/ (Vitest + jsdom), e2e/ (Playwright), fixtures/pages/
└── .github/workflows/  ci.yml, release.yml
```

Three rules hold the design together. Page-touching code lives in the content script; anything holding a key or making a network call lives in the background. Every provider speaks one OpenAI-compatible message shape, converted to the Anthropic Messages API only at the edge in `providers/byok.ts`. And `shared/payload.ts` is the single schema the extension, the Worker and the eval scripts all build against.

Four browser rules are worth knowing before changing the toolbar flow. A full-screen drag surface swallows the wheel, so the overlay forwards it to whatever is scrollable under the pointer — in the reader that is a container, not the window — and it never takes keyboard focus, which is what leaves arrows and space working. Escape is caught on `document` in capture and never needed focus. `sidePanel.open()` needs a live user gesture, and Chromium really does enforce it, so the panel is opened from the toolbar click — the one gesture that always counts — with a retry when the selection commits in case there was no tab to open against, and a one-click toast on the page as the last resort. Chrome will not inject a content script into an extension page, so the reader runs `lib/selection-controller.ts` itself and the background routes to it by a tab registry rather than by URL — `tabs.get` does not reveal a URL without the `tabs` permission. And pdf.js 6 calls `Map.getOrInsertComputed`, so the reader imports the legacy build to keep working on the browsers students actually run.

## Privacy and permissions

The manifest asks for `activeTab`, `scripting`, `storage` and `sidePanel` — no host permissions, because the content script is injected only when you invoke it. Nothing is sent until you ask; only the selection is sent, never the whole page. The extension ships no API key, loads no code from a server at runtime, and keeps no image in storage. Blocked sites (Options) turn the shortcut off entirely for hostnames you list.

## Next

Week 3 finishes selection: widening a text range to whole KaTeX or MathJax expressions, and Option-drag to subtract regions from a box. Week 4 adds hover-to-pick elements via `elementFromPoint`, which turns on the third mode chip. Weeks 5–6 are the extractors and the real planner, which is what Gate A measures.
