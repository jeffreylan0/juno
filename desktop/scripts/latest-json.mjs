/**
 * Writes latest.json, what the app's updater reads (src-tauri/src/updates.rs),
 * from the signed update files in a release folder: the Mac app as a .tar.gz
 * (one universal build for both kinds of Mac) and the Windows installer, each
 * with its .sig. Every signature is checked first against the update key's
 * public half, the one the builds carry, as installed apps will check it: a
 * file signed with another key, or changed after signing, stops the release
 * here rather than leaving every installed copy unable to update. A file
 * signed with another key says which key each is (as minisign names keys),
 * so the half that's wrong can be found.
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
/** A key id as minisign and `tauri signer` print it: its 8 bytes, last first, in hex. */
const idOf = (keyNum) => Buffer.from(keyNum).reverse().toString('hex').toUpperCase();
const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.subarray(10).toString('base64url') }, format: 'jwk' });

/**
 * Why `file`'s signature isn't a good one by this key, as the updater checks
 * it (minisign's); null when it is.
 */
function badSignature(file, sigText) {
  const [, sigLine = '', trusted = '', globalLine = ''] = lines(sigText);
  const sig = bytes(sigLine); // "ED" (hashed) or "Ed", key id (8), signature (64)
  const algorithm = sig.subarray(0, 2).toString();
  if (sig.length !== 74 || !['ED', 'Ed'].includes(algorithm) || !trusted.startsWith('trusted comment: ')) return 'its signature is not a minisign signature';
  if (!sig.subarray(2, 10).equals(key.subarray(2, 10))) {
    return (
      `it was signed with update key ${idOf(sig.subarray(2, 10))}, but the builds carry the public half of key ${idOf(key.subarray(2, 10))}. ` +
      'The private key the release signs with (TAURI_SIGNING_PRIVATE_KEY, in the `release` environment, or a repository secret of that name if the environment has none) ' +
      'and the public half (the TAURI_UPDATER_PUBKEY variable) are not one pair: desktop/README.md, Updates, says how to tell which is wrong'
    );
  }
  const data = readFileSync(file);
  const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const signature = sig.subarray(10);
  const comment = trusted.slice('trusted comment: '.length);
  const good = verify(null, message, publicKey, signature) && verify(null, Buffer.concat([signature, Buffer.from(comment)]), publicKey, bytes(globalLine));
  return good ? null : `its signature by key ${idOf(key.subarray(2, 10))} doesn't match it: the file changed after it was signed`;
}

const files = readdirSync(dir);
const signed = (ending) => files.find((f) => f.endsWith(`${ending}.sig`))?.slice(0, -'.sig'.length);
const entry = (file) => {
  const signature = readFileSync(join(dir, `${file}.sig`), 'utf8').trim();
  const bad = badSignature(join(dir, file), signature);
  if (bad) throw new Error(`${file}: ${bad}.`);
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
