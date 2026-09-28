# Selection AI

Select text, a box or a page element in the browser and ask Claude or ChatGPT about exactly that. A local planner sends each part in its cheapest exact form — text, LaTeX, a Markdown table, code — and adds a screenshot crop only where the content is visual or layout-sensitive. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

Chrome, Edge and Firefox from one WXT codebase; Safari from week 12.

## Status

Weeks 1–2 of the build plan are done: the workspace, the shared payload schema, the provider layer (mock, local, bring-your-own-key, hosted stub), capture and cropping, the router, the toolbar popup, the answer panel, the options page, the eval harness and CI. Weeks 3–6 add the real selectors and extractors.

| Area | State |
| --- | --- |
| Toolbar popup → selection → crop → plan → streamed answer | working, Chrome and Firefox |
| Box selection | working, with a centred hint and Escape to cancel |
| Text selection | working; KaTeX/MathJax range widening lands week 3 |
| Element selection | week 4 (the popup shows it disabled) |
| Extractors (visible, math, table, code) | `extract/visible.ts` only; rest weeks 4–5 |
| Providers | mock, local (Ollama), BYOK (Anthropic + OpenAI); gateway is a stub |
| Eval | 5 seed problems of 100; mock and image-only routes run |
| Worker, Stripe, Supabase | stubs with the week-9/10/11 shape |

The popup and the panel are deliberately unstyled beyond a set of CSS tokens at the top of `entrypoints/popup/popup.css` and `ui/panel.css`. Replacing those two blocks re-themes both.

## Quick start

```bash
pnpm install
cp .env.example .env.local     # PROVIDER=mock needs no keys
pnpm dev                       # Chrome with live reload
pnpm dev:firefox               # same in Firefox
```

Clicking the toolbar icon opens a small popup and arms a box selection at once, so the usual move is click, then drag. The popup's icons switch to text selection (element selection arrives in week 4); Escape cancels from either the popup or the page. The answer panel slides in only once a selection has been made. Alt+Shift+S and Alt+Shift+A skip the popup and arm box or text selection directly.

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
│   ├── entrypoints/    background, content/, popup/, sidepanel/, options/
│   ├── extract/        visible.ts (math, table, code land weeks 4–5)
│   ├── lib/            planner, capture, router, cache, storage, messages, render, providers/
│   └── ui/             Panel, Tray, Preview, Answer, WhatIRead
├── shared/             payload.ts (types), prompts.ts (mode prompts) — one schema for all three packages
├── worker/             Cloudflare Worker for hosted plans (week 9)
├── eval/               run, batch, score, crops, problems/
├── tests/              unit/ (Vitest + jsdom), e2e/ (Playwright), fixtures/pages/
└── .github/workflows/  ci.yml, release.yml
```

Three rules hold the design together. Page-touching code lives in the content script; anything holding a key or making a network call lives in the background. Every provider speaks one OpenAI-compatible message shape, converted to the Anthropic Messages API only at the edge in `providers/byok.ts`. And `shared/payload.ts` is the single schema the extension, the Worker and the eval scripts all build against.

Two browser rules are worth knowing before changing the toolbar flow. The popup holds keyboard focus while it is open, so it has to relay Escape to the page itself — and it must wait for that message to send before calling `window.close()`, or the message is dropped. And `sidePanel.open()` needs a real user gesture, which a message relayed from a content script does not reliably carry; when the panel cannot be opened after a selection, the background badges the toolbar icon and the popup offers a button that does carry one.

## Privacy and permissions

The manifest asks for `activeTab`, `scripting`, `storage` and `sidePanel` — no host permissions, because the content script is injected only when you invoke it. Nothing is sent until you ask; only the selection is sent, never the whole page. The extension ships no API key, loads no code from a server at runtime, and keeps no image in storage. Blocked sites (Options) turn the shortcut off entirely for hostnames you list.

## Next

Week 3 finishes selection: widening a text range to whole KaTeX or MathJax expressions, and Option-drag to subtract regions from a box. Week 4 adds hover-to-pick elements via `elementFromPoint`, which turns on the third popup icon. Weeks 5–6 are the extractors and the real planner, which is what Gate A measures.
