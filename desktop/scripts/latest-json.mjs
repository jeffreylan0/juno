/**
 * Writes latest.json, what the app's updater reads (src-tauri/src/updates.rs),
 * from the signed update files in a release folder: the Mac app as a .tar.gz
 * (one universal build for both kinds of Mac) and the Windows installer, each
 * with its .sig.
 *
 *   node desktop/scripts/latest-json.mjs <folder> <release tag> <owner/repo>
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, repo] = process.argv.slice(2);
if (!dir || !tag || !repo) throw new Error('usage: latest-json.mjs <folder> <tag> <owner/repo>');

const files = readdirSync(dir);
const signed = (ending) => files.find((f) => f.endsWith(`${ending}.sig`))?.slice(0, -'.sig'.length);
const entry = (file) => ({
  signature: readFileSync(join(dir, `${file}.sig`), 'utf8').trim(),
  url: `https://github.com/${repo}/releases/download/${tag}/${file}`,
});

const platforms = {};
const mac = signed('-mac.app.tar.gz');
if (mac) platforms['darwin-aarch64'] = platforms['darwin-x86_64'] = entry(mac);
const windows = signed('-windows-setup.exe');
if (windows) platforms['windows-x86_64'] = entry(windows);

const named = mac ?? windows;
if (!named) throw new Error(`no signed update files in ${dir}`);
const version = /^Juno-(.+)-(?:mac|windows)/.exec(named)?.[1];
if (!version) throw new Error(`can't tell the version from ${named}`);

writeFileSync(join(dir, 'latest.json'), `${JSON.stringify({ version, notes: `Juno ${version}`, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
console.log(`latest.json: ${version}, ${Object.keys(platforms).join(', ')}`);
