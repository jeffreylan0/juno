/**
 * Writes latest.json, what the app's updater reads (src-tauri/src/updates.rs),
 * from the signed update files in a release folder: the Mac app as a .tar.gz
 * (one universal build for both kinds of Mac) and the Windows installer, each
 * with its .sig. Every signature is checked first against the update key's
 * public half, as installed apps will check it: a file signed with the wrong
 * key, or changed after signing, stops the release here rather than leaving
 * every installed copy unable to update.
 *
 *   node desktop/scripts/latest-json.mjs <folder> <release tag> <owner/repo> <public key>
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, tag, repo, pubkey] = process.argv.slice(2);
if (!dir || !tag || !repo || !pubkey) throw new Error('usage: latest-json.mjs <folder> <tag> <owner/repo> <public key>');

/** A minisign key or signature line's bytes (Tauri wraps each file in base64 once more). */
const lines = (b64) => Buffer.from(b64.trim(), 'base64').toString('utf8').trim().split('\n');
const bytes = (line) => Buffer.from(line.trim(), 'base64');

const key = bytes(lines(pubkey)[1] ?? ''); // "Ed", key id (8), Ed25519 public key (32)
if (key.length !== 42) throw new Error('the public key is not a minisign key');
const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') }, format: 'jwk' });

/** Whether `file` carries a good signature by this key: minisign's, as the updater checks it. */
function signedByKey(file, sigText) {
  const [, sigLine = '', trusted = '', globalLine = ''] = lines(sigText);
  const sig = bytes(sigLine); // "ED" (hashed) or "Ed", key id (8), signature (64)
  const algorithm = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || !['ED', 'Ed'].includes(algorithm) || !sig.subarray(2, 10).equals(key.subarray(2, 10))) return false;
  if (!trusted.startsWith('trusted comment: ')) return false;
  const data = readFileSync(file);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const signature = sig.subarray(10);
  const comment = trusted.slice('trusted comment: '.length);
  return (
    verify(null, message, publicKey, signature) &&
    verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicKey, bytes(globalLine))
  );
}

const files = readdirSync(dir);
const signed = (ending) => files.find((f) => f.endsWith(`${ending}.sig`))?.slice(0, -'.sig'.length);
const entry = (file) => {
  const signature = readFileSync(join(dir, `${file}.sig`), 'utf8').trim();
  if (!signedByKey(join(dir, file), signature)) throw new Error(`${file}: its signature doesn't match the update key's public half`);
  return { signature, url: `https://github.com/${repo}/releases/download/${tag}/${file}` };
};

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
console.log(`latest.json: ${version}, ${Object.keys(platforms).join(', ')}, signatures checked`);
