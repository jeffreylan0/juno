# Juno

Draw a box or any shape around something on screen and ask Claude or ChatGPT about exactly that. Only the selection is sent, as its screenshot: every model we use reads images, text and maths included. Answers render with KaTeX and mhchem, so math, chemistry and physics come out readable.

A desktop app for macOS and Windows, built with [Tauri 2](https://tauri.app). It works over anything on screen: PDFs in Preview or Acrobat, slides, video calls, websites in any browser, full-screen apps. A product of humanbn ([humanbn.com](https://humanbn.com), info@humanbn.com).

Juno began as a browser extension (Chrome, Edge and Firefox). The extension is retired; its code that the app runs now lives in `desktop/`, and the rest is gone. `desktop/README.md` is the app's developer guide, and `TESTERS.md` is what testers read.

## Status

| Area | State |
| --- | --- |
| Shortcut (⌥⇧S on a Mac, Alt+Shift+S on Windows) or the menu bar / tray icon → selection → native crop → streamed answer | working on macOS 14+ and Windows 10/11; tested end to end on Linux |
| Box selection | sends on release; optionally waits with resize-and-move handles; Escape cancels, ✕ closes everything |
| Freeform selection | draw any closed shape; the AI sees only what is inside the outline |
| The bar | one dark row in the manner of Claude's quick entry, always armed in Box; while the panel is open its chats, ghost and gear fold smoothly away; where it sits is a setting (a 3×3 grid of the screen; the bottom edge to start) |
| The panel | a card that grows with its chat, placed by the same kind of setting (top right to start); resized by hand, it keeps that size. Questions in rounded bubbles with copy, edit and retry; answers stream at an even pace with a copy button; the view follows the answer unless you scroll up |
| Chats | the panel opens with the first selection; ✕ (bar or panel) or Escape hides both and finishes the chat; ⌘⇧O / Ctrl+Shift+O finishes it and brings the bar up for the next; a chat menu with search, rename and delete; temporary (ghost) chats; 1, 5, 10, 25, 50 or 100 chats kept on this computer |
| Macros | Explain, Hint, Check and Answer (the answer first, then the explanation) to start with; yours to rename, rewrite and add to |
| Settings | Answers, Asking, Selecting, Appearance (seven colour themes), Chats & privacy, Permissions (macOS), Juno (version, updates, login, Quit), and Account in builds with accounts; short text, saved as you go |
| Updates | the app looks for a new version at start and every 6 hours, downloads it in the background and installs it when nothing of it is on screen, then restarts into the menu bar; on unless turned off. Needs the owner's update key (desktop/README.md, *Updates*) |
| Real answers | your own Anthropic or OpenAI key: free key check, model picker beside the macros, prompt caching for follow-ups, errors that say what to do; temporary chats ask for the shortest retention the API allows |
| Providers | placeholder, local (Ollama), your own key (Anthropic, OpenAI), hosted (the Worker: Claude Haiku 5.5 or GPT-6 Luna, quick and cheap, for plans with hosted answers) |
| Accounts and plans | optional: Google or an emailed code (Supabase). Plans (Free, Plus, given by hand) with hosted answers and cloud storage of chats; Plus as a pass bought once with Stripe (*Plans* below). Built; turned on by the setup in `supabase/README.md` |
| Permissions | Screen Recording only, on macOS; Windows asks for nothing |
| Eval | 5 seed problems of 100; mock and image-only routes run |

## Quick start

```bash
pnpm install
cp .env.example .env.local     # WXT_PROVIDER=mock needs no keys
pnpm dev                       # the app with live reload
```

On a Mac, try permissions with `pnpm app` instead (a real `Juno.app`, so macOS asks on Juno's behalf, not your terminal's): see `desktop/README.md`, *Running it*.

The default is placeholder answers: no network, no spend. To get real answers, open Settings (the gear on the bar or the panel), choose Claude or ChatGPT, paste a key and press **Check key**, which lists the models the key can use and costs nothing. *Automatic* picks Claude Sonnet 5.5 (GPT-6 Sol on OpenAI), which read screenshots best. Set a spend limit in the vendor's console. Or point at a local Ollama server:

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

Rules that keep spend near zero: develop against `mock`; every paid eval answer is written into `eval/cache` by payload hash, so reruns replay for free (the app itself keeps no answer cache, so nothing outlives its chat); planner or prompt changes run the eval on `mock` and `local` first, and the paid batch eval runs weekly and before each gate.

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

Your own keys and your sign-in session never leave the computer except to the service they belong to: an Anthropic key only to Anthropic, an OpenAI key only to OpenAI, the session only to Supabase and the Worker.

- They are kept in one file, `secrets.json` in the app's data folder (`~/Library/Application Support/com.humanbn.juno/store/` on macOS, `%LOCALAPPDATA%\com.humanbn.juno\store\` on Windows, never the roaming profile), readable only by your user account (mode 0600 on macOS and Linux; the user's own profile folder on Windows). The overlay window, drawn over whatever is on screen, can't read it at all.
- Not the keychain: macOS ties a keychain item to the exact build that made it, so every unsigned build asked for the keychain password. Once the app is signed with a Developer ID, the keychain can hold the file's key without prompts.
- This protects against other accounts on the computer, not against software running as you.
- **Plans**: a student on a plan sends no key at all. Hosted answers go through the Worker with the session token; the Worker holds the service's own keys. Payments go through Stripe's own pages: card details never touch the app or the Worker.

## Privacy

The app asks for Screen Recording on macOS and nothing on Windows: no keychain, accessibility, microphone or input monitoring. It looks at the screen only when you select something, and only the selection is sent, when you ask. It ships no API key and loads no code from a server at runtime. Chats are kept on this computer: saved chats and their screenshots in the app's data folder, temporary chats in memory only, deleted with their screenshots when finished. Settings → *Chats & privacy* → *Delete all chats* clears them, and how many saved chats are kept is the student's choice (1 to 100). Signing in is optional; an account whose plan includes cloud storage can turn on a copy of its saved chats and screenshots in Supabase (a private bucket, one folder per account, row level security on every table), and temporary chats are never copied. No answer is cached anywhere by the app.

Neither Anthropic nor OpenAI trains on API traffic by default (OpenAI does if the key's organization opted in to data sharing). Anthropic deletes API inputs and outputs within 30 days (longer only for usage-policy flags) and has no per-request retention setting; its prompt cache is memory-only. OpenAI keeps abuse-monitoring logs up to 30 days; every request is sent with `store: false`, and a temporary chat also asks for `prompt_cache_retention: "in_memory"`, falling back (once per model) where a model offers only the 24-hour cache. On the hosted route the Worker keeps nothing: AI Gateway logging and its response cache are off on every request, and each chat gets its own prompt-cache scope, so no student's cached prompt can serve, or be probed by, another (SECURITY.md, *Prompt caching*). A local model on this computer never sends anything off it; settings warn when its address is elsewhere (and, over plain HTTP, that the screenshots would cross the network unencrypted). Settings → *Chats & privacy* → *What is sent, and what is kept* says the same in plain words.

Model answers are DOMPurify-sanitized and inserted as nodes, links open in the student's browser, and nothing in an answer is fetched: no images, no CSS `url()` or `image-set()`, no `background` attributes, no SVG or MathML images, and no fixed or absolute layers over the panel. The pages' CSP refuses remote images, media and fonts as a second wall. A page on screen can try to steer the model into emitting a URL that carries data out (prompt injection); there is nowhere for it to go without the student clicking a link. `desktop/harden-libs.ts` removes, at build time, dead paths in React (`dangerouslySetInnerHTML`, unused) and DOMPurify (its non-DOMParser fallback); each edit must match or the build fails, so a library upgrade cannot ship half-patched. Security as a whole, and what the owner sets up: `SECURITY.md`.

## Plans

Juno is a passion project: plans are priced to cover what hosted answers and the services cost, not to make a profit.

| Plan | Price | What it gives |
| --- | --- | --- |
| Free | $0 | Everything, unlimited, with your own API key or a local model. 100 hosted answers a month once sign-up has CAPTCHA (`supabase/README.md`, step 10); 0 until then |
| Plus, semester | $4.99 once, for 120 days | Hosted answers (up to 3,000 a month, about 100 a day: more than anyone uses) and cloud sync |
| Plus, year | $11.99 once, for 365 days | The same |

- **Paid once, nothing renews.** Students pay at most a few dollars a term, and don't want to think about payment again; a pass can't surprise them with a charge.
- **One fast model, no "think harder".** Hosted answers go to Claude Haiku 5.5 (or GPT-6 Luna) at low effort: about $0.0006 an answer, so even a heavy month costs well under a pass's share. A student who wants a bigger model brings their own key.
- **What it costs to run:** about $0.20 a month for a typical Plus student (300 answers), and $31–56 a month of fixed costs (Supabase, Cloudflare, Apple's developer fee, Windows code signing, domain and email). A pass nets about $1 a month after Stripe's fee, so 40–70 paying students cover everything (free students' hosted answers add at most 6¢ each a month).
- **Before launch:** run the eval with Haiku 5.5 against Sonnet 5.5 (on at least 50 problems) to confirm the fast model reads screenshots well enough.
- **Later, without raising prices:** themes and macros sold on the website (a marketplace), and an optional "support Juno" tip.

## Rebranding

What the app calls itself in its pages lives in `desktop/src/brand.ts`. The app's name, bundle id (`com.humanbn.juno`) and link scheme (`com.humanbn.juno://`) are in `desktop/src-tauri/tauri.conf.json`. The icon is drawn once, in `desktop/assets/icon.svg`; `desktop/scripts/icons.mjs` renders it to every size the app needs.

The product was called Selection AI until it became Juno. From the first public release on, keep the bundle id unchanged through any rename, or macOS and Windows treat the renamed app as a new one and existing users stop getting updates. Names nobody sees keep the old project name on purpose: the repository, the packages and crate, log prefixes, and storage key names, which hold students' chats and screenshots and would be lost if renamed.

The outward contact is info@humanbn.com: store listings, Stripe, Google's sign-in screen, the privacy policy, testers. The management address that owns the service accounts is deliberately not written anywhere in this public repository (SECURITY.md).

## Next

Test builds (a Mac `.dmg` and a Windows `.exe`, without accounts) come from the *Test build* workflow; `TESTERS.md` is what testers read. Accounts, plans and billing are built but off until the services are set up: `supabase/README.md` goes through it step by step. Then the eval set and Gate A, and a signed and notarized Mac build.

Ideas from testing kept for later, as possible settings: a visible *New chat* button in the panel (the key does it today), and keeping no saved chats at all (the ghost covers it today). Planned: a marketplace on the website for themes and macros (themes are already data: `desktop/src/lib/themes.ts`).
