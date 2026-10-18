/**
 * `pnpm app`: builds the app as a real .app (debug) and opens it.
 *
 * `pnpm dev` runs a bare binary from a terminal, so macOS asks for
 * Screen Recording on behalf of whatever started it (VS Code, Terminal) and,
 * if allowed, grants it to that app instead. Run as a bundle, the prompt
 * names Juno and the permission is the app's alone.
 *
 * Signed ad hoc, each rebuild is a new app to macOS, which then asks again.
 * Set APPLE_SIGNING_IDENTITY to an Apple Development certificate's name and
 * the permission survives rebuilds.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'darwin') {
  console.log('Only macOS asks for a permission; on this system `pnpm dev` is the same thing.');
  process.exit(0);
}
const built = spawnSync('pnpm', ['tauri', 'build', '--debug', '--bundles', 'app'], { cwd: resolve(here, '..'), stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const app = resolve(here, '../src-tauri/target/debug/bundle/macos/Juno.app');
if (!existsSync(app)) {
  console.error(`Built, but no app at ${app}`);
  process.exit(1);
}
spawnSync('open', ['-n', app], { stdio: 'inherit' });
