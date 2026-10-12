# Building the Firefox add-on from source (for Mozilla reviewers)

The submitted file `extension-0.1.0-firefox.zip` is produced from this source by the steps below. A clean rebuild is byte-for-byte identical to the submitted package (checked by unzipping both and comparing every file).

## Tools that process the code

- **WXT 0.21.4**, which runs **Vite 8 / Rolldown**: compiles the TypeScript and React (TSX) sources, bundles them with their npm dependencies, and minifies the result. Nothing is generated except by this build.
- **`extension/harden-libs.ts`**: a small build plugin, part of this source, that removes unused code paths from three libraries while bundling (React's `dangerouslySetInnerHTML` writes, DOMPurify's non-DOMParser fallback, and pdf.js's `Function('return this')` and computed `import()` paths). The file explains each edit.
- No remote code is loaded at runtime. Every dependency comes from the npm registry at the exact versions in `pnpm-lock.yaml`: React, react-dom, DOMPurify, marked, KaTeX, pdfjs-dist (the PDF.js fonts, cmaps and WebAssembly decoders are copied unchanged into `extension/public/pdfjs/`).

## Requirements

- Linux or macOS (built and checked on Ubuntu 24.04; macOS works the same way).
- Node.js 22 (checked with 22.22.2): <https://nodejs.org/>
- pnpm 10.28.0, the version pinned in `package.json`. With Node installed: `corepack enable` (or `npm install -g pnpm@10.28.0`).

## Steps

From the root of this archive:

```bash
corepack enable                      # provides pnpm 10.28.0
pnpm install --frozen-lockfile       # exact dependency versions from pnpm-lock.yaml
pnpm --filter extension zip:firefox  # build and package the Firefox add-on
```

The add-on is written to `extension/.output/extension-0.1.0-firefox.zip` (the unpacked build is in `extension/.output/firefox-mv3/`).

Notes:

- pnpm prints "Ignored build scripts: esbuild, workerd". That is expected; the build does not need those install scripts.
- Build with no `E2E` or `WXT_*` environment variables set. If the archive contains `extension/.env.local`, leave it in place: it holds the two public account-service settings (`WXT_SUPABASE_URL`, `WXT_SUPABASE_KEY`) the submitted build was made with. (`E2E=1` produces a test-only build with extra host permissions; it is never submitted.)

## Where the code is

- `extension/entrypoints/` — background script, content script, side panel/sidebar, options page, PDF reader.
- `extension/lib/`, `extension/ui/` — the extension's own modules.
- `shared/` — the request schema and prompts shared with the (not shipped) server and eval code.
- `worker/`, `supabase/`, `eval/`, `tests/` — the hosted-answer and billing server, the account database schema, an evaluation harness and tests; none of it is part of the add-on.
