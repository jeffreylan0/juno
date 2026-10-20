# Juno

Draw a box or any shape around something on screen and ask Claude or ChatGPT about exactly that. Only the selection is sent, as its screenshot: every model we use reads images, text and maths included. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

A desktop app for macOS and Windows, built with [Tauri 2](https://tauri.app). It works over anything on screen: PDFs in Preview or Acrobat, slides, video calls, websites in any browser, full-screen apps. A product of humanbn ([humanbn.com](https://humanbn.com), info@humanbn.com).

Juno began as a browser extension (Chrome, Edge and Firefox). The extension is retired; its code that the app runs now lives in `desktop/`, and the rest is gone. `desktop/README.md` is the app's developer guide, and `TESTERS.md` is what testers read.

## Status

| Area | State |
| --- | --- |
| Shortcut (⌥⇧S on a Mac, Alt+Shift+S on Windows) or the menu bar / tray icon → selection → native crop → streamed answer | working on macOS 14+ and Windows 10/11; tested end to end on Linux |
| Box selection | while it is drawn, the bar and the panel step aside, back the moment it is made; Escape closes everything at any point; sends on release; optionally waits with resize-and-move handles; Escape cancels, ✕ closes everything |
| Freeform selection | draw any closed shape; the AI sees only what is inside the outline |
| The bar | one dark row in the manner of Claude's quick entry, always armed in Box; while the panel is open its chats, ghost and gear fold smoothly away; where it sits is a setting (a 3×3 grid of the screen; the bottom edge to start) |
| The panel | a card that grows with its chat, placed by the same kind of setting (top right to start); resized by hand, it keeps that size. Questions in rounded bubbles with copy, edit and retry; answers stream at an even pace with a copy button; the view follows the answer unless you scroll up |
| Chats | the panel opens with the first selection; ✕ (bar or panel) or Escape hides both and finishes the chat (Escape anywhere in Juno, even with the chat menu or an edit open, closes all of it); ⌘⇧O / Ctrl+Shift+O finishes it and brings the bar up for the next; a chat menu with search, rename and delete; temporary (ghost) chats; 1, 5, 10, 25, 50 or 100 chats kept on this computer |
| Macros | Explain, Hint, Check and Answer (the answer first, then the explanation) to start with; yours to rename, rewrite and add to, each a card of its own in Settings → *Macros* |
| First launch | once, after installing: a selection drawn in a viewfinder, a shutter blink, the mark stepping aside for the name, then *Sign up or sign in* (optional) or on without an account, into the setup. CSS only; with reduced motion, just the last frame |
| Settings | opens only from the gear (or the icon's menu), above the panel, at one size (never full screen), and goes away when closed; Escape closes it, and the rest of Juno with it. At the top, a profile (your picture, name and plan, or *Guest* with *Sign up or sign in*, and why: hosted answers and cloud storage) beside the plan: hosted answers left in a white badge, or this month's answers, spend and who answers, and for a guest the unlock; then the settings, most used first, each with a line saying what it is for: Answers, Asking, Macros, Appearance (light, dark or the system's; five colour themes, Ember to start), Selecting, Chats & privacy, the account's settings, Permissions (macOS), Juno (version, updates, login, privacy policy and terms, Quit). Once scrolled to them, a menu of them fades in at the side. Short text, saved as you go |
| Updates | the app looks for a new version at start and every 6 hours, downloads it in the background and installs it when nothing of it is on screen, then restarts into the menu bar; on unless turned off. Needs the owner's update key (desktop/README.md, *Updates*) |
| Real answers | your own Anthropic or OpenAI key, in one field (the key itself says whose; admin keys are refused): free key check, model picker beside the macros, prompt caching for follow-ups, errors that say what to do; temporary chats ask for the shortest retention the API allows. Room for the model's thinking as well as its answer (32,000 tokens; 4,096 cut hard answers short or left none); a question Claude's safeguards decline is answered by the model Anthropic recommends for it, in the same request (Sonnet, Opus, Fable), and otherwise said plainly, as is an answer cut off at the limit |
| Providers | local (Ollama), your own key (Anthropic, OpenAI), hosted (the Worker: Claude Haiku 5.5 or GPT-6 Luna, quick and cheap, for plans with hosted answers); the first start sets one up. Placeholder answers remain for the eval and tests only |
| Accounts and plans | optional: Google (on Google's own page, in the app's name) or an emailed code (Supabase). Plans (Free, Plus, given by hand) with hosted answers and cloud storage of chats; Plus renews with Stripe every 120 days or every year; without an account, a one-time unlock opens the extras (*Plans* below). Built; turned on by the setup in `supabase/README.md` |
| Permissions | Screen Recording only, on macOS; Windows asks for nothing |
| Eval | 5 seed problems of 100; mock and image-only routes run |

## Quick start

```bash
pnpm install
cp .env.example .env.local     # optional: accounts, the eval's keys
pnpm dev                       # the app with live reload
```

On a Mac, try permissions with `pnpm app` instead (a real `Juno.app`, so macOS asks on Juno's behalf, not your terminal's): see `desktop/README.md`, *Running it*.

The first start opens the setup: paste an Anthropic or OpenAI key (the key says whose; it is checked at once by listing the models it can use, which costs nothing), point at a local model, or, in builds with accounts, sign in for hosted answers. Settings → *Answers* changes it later. *Automatic* picks Claude Sonnet 5.5 (GPT-6 Sol on OpenAI), which read screenshots best. Set a spend limit in the vendor's console. A local Ollama server:

```bash
ollama pull qwen2.5vl:7b
ollama serve                   # OpenAI-compatible on http://localhost:11434/v1
```

## Daily workflow

| Task | Command |
| --- | --- |
| The app with live reload | `pnpm dev` |
| A real debug `Juno.app` (macOS permissions) | `pnpm app` |
| Release build | `pnpm build` |
| Unit tests (Vitest + jsdom) | `pnpm test` |
| Native tests (Rust) | `pnpm test:native` |
| End to end (Linux, Xvfb) | `pnpm test:e2e` |
| Typecheck everything | `pnpm typecheck` |
| Worker locally | `pnpm worker:dev` |

Rules that keep spend near zero: run the eval on `mock` while working on it; every paid eval answer is written into `eval/cache` by payload hash, so reruns replay for free (the app itself keeps no answer cache, so nothing outlives its chat); planner or prompt changes run the eval on `mock` and `local` first, and the paid batch eval runs weekly and before each gate.

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

The build plan's planner, which re-sent a selection as extracted text, LaTeX or tables where it could, is not used by the app: text scraped from under a box garbled real layouts and duplicated the screenshot. The eval keeps the `planner` route so the idea can still be measured.

## Layout

```
selection-ai/
├── desktop/            the app (Tauri 2)
│   ├── src-tauri/      the native core (Rust): shortcut, menu bar icon, windows, capture, crop, storage
│   ├── src/            the web side, in four windows: core/ (chats and answers), overlay/ (the bar),
│   │                   panel/, settings/; lib/ (engine, chats, planner, providers/, account/, …),
│   │                   ui/ (the panel's components), selection/ (the bar and the selectors),
│   │                   platform/ (a WebExtension-shaped `browser` over the native core)
│   ├── web/            the four pages
│   └── tests/e2e/      the app end to end, on a virtual display
├── shared/             payload.ts (types), prompts.ts (prompts and macros): one schema for the app, the Worker and the eval
├── worker/             Cloudflare Worker: hosted answers (auth.ts, quota.ts, models.ts) and billing (billing.ts, Stripe)
├── supabase/           migrations/ (the schema), tests/ (checked on local PostgreSQL), README.md (the full setup)
├── eval/               run, batch, score, crops, problems/
├── tests/              unit/ (Vitest + jsdom), fixtures/
└── .github/workflows/  ci.yml, desktop.yml (the app on Linux, macOS and Windows), desktop-release.yml (test builds)
```

Two rules hold the design together. Every provider speaks one OpenAI-compatible message shape, converted to the Anthropic Messages API only at the edge in `lib/providers/byok.ts`. And `shared/payload.ts` is the single schema the app, the Worker and the eval scripts all build against.

## How keys are stored

An API key is safe in the app because of how it is built, not because of a promise: once it goes in, no page of the app can read it back, and it can only ever be sent to the company that issued it.

- **No page holds it.** Settings hands the key to the native core (`desktop/src-tauri/src/vault.rs`) and forgets it. The storage commands never read, write or announce it to any window; pages learn only whether there is one, by its last four characters. A page that was somehow taken over (a crafted answer, a bad package) still can't read it.
- **Only to its own company.** The key's own prefix says whose it is (`sk-ant-` Anthropic, `sk-` OpenAI), and it is kept for that company alone; admin keys, which can't answer, are refused. Asking goes through the native core, which adds the key itself and sends only to four endpoints: asking and listing models, at `api.anthropic.com` or `api.openai.com`, over HTTPS, following no redirect. Any other request with a key is refused. The answer streams back; the key never does.
- **Private on disk.** It is kept in one file, `secrets.json` in the app's data folder (`~/Library/Application Support/com.humanbn.juno/store/` on macOS, `%LOCALAPPDATA%\com.humanbn.juno\store\` on Windows, never the roaming profile): mode 0600 on macOS and Linux, and on Windows also encrypted for your user by the system (DPAPI), so a copy is useless on another computer or account. Not the macOS keychain: it ties an item to the exact build that made it, so every unsigned build asked for the keychain password.
- **Checked by tests.** Rust tests prove the endpoint allowlist and the private file; an end-to-end test saves a key and then tries, from every window, to read it, write it, or send it anywhere else, and fails each time.
- This protects against the app's own pages and other accounts on the computer, not against software running as you.
- The account session (the sign-in) is in the same file and goes only to Supabase and the Worker; the overlay can't read it.
- **No other site in the app's windows.** Each window loads only the app's own pages, so a link that got into an answer can't open a lookalike page asking for your key inside the app: links open in your browser.
- **Plans**: a student on a plan sends no key at all. Hosted answers go through the Worker with the session token; the Worker holds the service's own keys. Payments go through Stripe's own pages: card details never touch the app or the Worker.

## Privacy

The app asks for Screen Recording on macOS and nothing on Windows: no keychain, accessibility, microphone or input monitoring. It looks at the screen only when you select something, and only the selection is sent, when you ask. It ships no API key and loads no code from a server at runtime. Chats are kept on this computer: saved chats and their screenshots in the app's data folder, temporary chats in memory only, deleted with their screenshots when finished. Settings → *Chats & privacy* → *Delete all chats* clears them, and how many saved chats are kept is the student's choice (1 to 100). Signing in is optional; an account whose plan includes cloud storage can turn on a copy of its saved chats and screenshots in Supabase (a private bucket, one folder per account, row level security on every table), and temporary chats are never copied. No answer is cached anywhere by the app.

Neither Anthropic nor OpenAI trains on API traffic by default (OpenAI does if the key's organization opted in to data sharing). Anthropic deletes API inputs and outputs within 30 days (longer only for usage-policy flags) and has no per-request retention setting; its prompt cache is memory-only. OpenAI keeps abuse-monitoring logs up to 30 days; every request is sent with `store: false`, and a temporary chat also asks for `prompt_cache_retention: "in_memory"`, falling back (once per model) where a model offers only the 24-hour cache. On the hosted route the Worker keeps nothing: AI Gateway logging and its response cache are off on every request, and each chat gets its own prompt-cache scope, so no student's cached prompt can serve, or be probed by, another (SECURITY.md, *Prompt caching*). A local model on this computer never sends anything off it; settings warn when its address is elsewhere (and, over plain HTTP, that the screenshots would cross the network unencrypted). Settings → *Chats & privacy* → *What is sent, and what is kept* says the same in plain words.

Model answers are DOMPurify-sanitized and inserted as nodes, links open in the student's browser, and nothing in an answer is fetched: no images, no CSS `url()` or `image-set()`, no `background` attributes, no SVG or MathML images, and no fixed or absolute layers over the panel. The pages' CSP refuses remote images, media and fonts as a second wall. A page on screen can try to steer the model into emitting a URL that carries data out (prompt injection); there is nowhere for it to go without the student clicking a link. `desktop/harden-libs.ts` removes, at build time, dead paths in React (`dangerouslySetInnerHTML`, unused) and DOMPurify (its non-DOMParser fallback); each edit must match or the build fails, so a library upgrade cannot ship half-patched. Security as a whole, and what the owner sets up: `SECURITY.md`.

The privacy policy and terms of service are in `legal/` (published at humanbn.com/privacy and /terms, linked from Settings → Juno and the sign-in); `legal/README.md` lists what to fill in before publishing.

## Plans

Juno is a passion project: plans are priced to cover what hosted answers and the services cost, not to make a profit.

| Plan | Price | What it gives |
| --- | --- | --- |
| Free | $0 | Everything, unlimited, with your own API key or a local model, with the default theme (Ember), the default places for the bar and the panel, and two macros. 100 hosted answers a month once sign-up has CAPTCHA (`supabase/README.md`, step 10); 0 until then |
| Unlock (no account) | $4.99 once | The extras: every theme, your own places for the bar and the panel, more than two macros, on the computer it was bought on (no code to pass around; *Restore* brings it back after a reinstall). Shown as *Plus* in the plan |
| Plus, semester | $4.99 every 120 days | The extras, hosted answers (up to 3,000 a month) and cloud sync. Renews until cancelled |
| Plus, year | $11.99 a year | The same |

- **Guests first.** Juno is complete without an account: own key or local model, no nagging. The extras (`desktop/src/lib/extras.ts`) are the only thing held back, greyed with a button to the plan; closed, what was chosen is kept, not undone. The unlock (`worker/src/unlock.ts`) costs nothing to serve, so it is nearly all margin after Stripe's fee (about $4.55 of $4.99).
- **Plus renews.** Every 120 days or every year, until cancelled from *Manage billing*; Stripe emails before a yearly renewal. The Worker still handles one-time passes (a one-time price with days after its key in `STRIPE_PRICES`).
- **One fast model, no "think harder".** Hosted answers go to Claude Haiku 5.5 (or GPT-6 Luna) at low effort: about $0.0005 an answer ($0.10 / $0.50 per million tokens in and out). The Worker allows nothing else, so what a student asks can't pick a pricier model. A student who wants a bigger model brings their own key, and pays its company directly.
- **What it costs to run:** about $0.15 a month for a typical Plus student (300 answers); at the full 3,000 answers a month, about $1.50, more than a semester plan brings in (about $1.10 a month after Stripe's fee), so watch the heaviest accounts, or lower the cap, should many reach it. $31–56 a month of fixed costs (Supabase, Cloudflare, Apple's developer fee, Windows code signing, domain and email).
- **Before launch:** run the eval with Haiku 5.5 against Sonnet 5.5 (on at least 50 problems) to confirm the fast model reads screenshots well enough.
- **Later, without raising prices:** themes and macros sold on the website (a marketplace), and an optional "support Juno" tip. Bigger hosted models would need metering by cost rather than by answer (Opus 5.5 costs about 40 times Haiku 5.5 a token).

## Rebranding

What the app calls itself in its pages lives in `desktop/src/brand.ts`. The app's name and bundle id (`com.humanbn.juno`) are in `desktop/src-tauri/tauri.conf.json`. The icon is drawn once, in `desktop/assets/icon.svg`; `desktop/scripts/icons.mjs` renders it to every size the app needs.

The product was called Selection AI until it became Juno. From the first public release on, keep the bundle id unchanged through any rename, or macOS and Windows treat the renamed app as a new one and existing users stop getting updates. Names nobody sees keep the old project name on purpose: the repository, the packages and crate, log prefixes, and storage key names, which hold students' chats and screenshots and would be lost if renamed.

The outward contact is info@humanbn.com: store listings, Stripe, Google's sign-in screen, the privacy policy, testers. The management address that owns the service accounts is deliberately not written anywhere in this public repository (SECURITY.md).

## Next

Test builds (a Mac `.dmg` and a Windows `.exe`) come from the *Test build* workflow, with accounts once the repository's Actions variables are set (`supabase/README.md`, step 7); `TESTERS.md` is what testers read. Accounts, plans and billing are set up step by step in `supabase/README.md`. Then the eval set and Gate A, and a signed and notarized Mac build.

Ideas from testing kept for later, as possible settings: a visible *New chat* button in the panel (the key does it today), and keeping no saved chats at all (the ghost covers it today). Planned: a marketplace on the website for themes and macros (themes are already data: `desktop/src/lib/themes.ts`).
