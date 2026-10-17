# Working on Juno

Juno is a desktop app (Tauri 2) in `desktop/`, with `shared/`, `worker/`, `supabase/` and `eval/` beside it. The browser extension it began as is retired: work only on the app, and don't bring extension code, workflows or docs back. `README.md` is the overview, `desktop/README.md` the developer guide, `TESTERS.md` what testers read, `SECURITY.md` the security model.

## Every round

1. Make the change, with tests where behaviour changes.
2. **Trim before finishing.** Skim the code the round touched, and the code around it, for what no longer earns its place: unused files, exports and parameters; branches for cases that can no longer happen; comments and docs that describe removed behaviour or the retired extension. Remove it without changing what the app does. Say in the round's report what was trimmed.
3. Verify, then commit and push:
   - `pnpm typecheck` and `pnpm test` (unit), `pnpm test:native` (Rust).
   - `pnpm test:e2e` (the real app on Xvfb) when the bar, the panel, settings or the native core changed.
   - For Rust changes, the Windows cross-check, in `desktop/`: `CARGO_TARGET_DIR=src-tauri/target/win cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu`.
4. Update the docs the change affects (the four above).

## Never

- Put an API key or other secret in the repository or in a build.
- Write the management email address anywhere in this repository. The outward contact is info@humanbn.com.
- Ask for more permissions than the app needs (Screen Recording on macOS, nothing on Windows).
