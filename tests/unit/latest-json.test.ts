// @vitest-environment node
/**
 * The release's last check before an update is published
 * (desktop/scripts/latest-json.mjs): every update file's signature must be a
 * good one by the key the builds carry, as installed copies will check it.
 * Keys and signatures are made here as minisign (and so Tauri's updater)
 * makes them; a file signed with another key says which key each is.
 */
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '../../desktop/scripts/latest-json.mjs');
const wrap = (text: string) => Buffer.from(text).toString('base64');

/** A minisign key pair: its public half as Tauri stores it, and a signer. */
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyNum = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const id = Buffer.from(keyNum).reverse().toString('hex').toUpperCase();
  const pub = wrap(`untrusted comment: minisign public key: ${id}\n${Buffer.concat([Buffer.from('Ed'), keyNum, raw]).toString('base64')}\n`);
  const signFile = (file: string) => {
    const signature = sign(null, createHash('blake2b512').update(readFileSync(file)).digest(), privateKey);
    const comment = `timestamp:1\tfile:${file.split('/').pop()}`;
    const global = sign(null, Buffer.concat([signature, Buffer.from(comment)]), privateKey);
    const sigLine = Buffer.concat([Buffer.from('ED'), keyNum, signature]).toString('base64');
    writeFileSync(`${file}.sig`, wrap(`untrusted comment: signature from tauri secret key\n${sigLine}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`));
  };
  return { id, pub, signFile };
}

/** A release folder with both update files, signed by `signer`. */
function release(signer: ReturnType<typeof keyPair>) {
  const dir = mkdtempSync(join(tmpdir(), 'juno-release-'));
  for (const name of ['Juno-1.2.3-mac.app.tar.gz', 'Juno-1.2.3-windows-setup.exe']) {
    writeFileSync(join(dir, name), randomBytes(4096));
    signer.signFile(join(dir, name));
  }
  return dir;
}

const check = (dir: string, pub: string) => {
  try {
    return { ok: true, out: execFileSync('node', [SCRIPT, dir, 'desktop-v1.2.3', 'o/r', pub], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (err) {
    return { ok: false, out: String((err as { stderr?: string }).stderr) };
  }
};

describe('latest.json, after every signature is checked', () => {
  it('is written when each file is signed by the key the builds carry', () => {
    const key = keyPair();
    const dir = release(key);
    expect(check(dir, key.pub).ok).toBe(true);
    const latest = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    expect(latest.version).toBe('1.2.3');
    expect(Object.keys(latest.platforms).sort()).toEqual(['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64']);
    expect(latest.platforms['windows-x86_64'].url).toBe('https://github.com/o/r/releases/download/desktop-v1.2.3/Juno-1.2.3-windows-setup.exe');
  });

  it('is refused when the release signed with another key, naming both keys', () => {
    const signedWith = keyPair();
    const builds = keyPair();
    const { ok, out } = check(release(signedWith), builds.pub);
    expect(ok).toBe(false);
    expect(out).toContain(`signed with update key ${signedWith.id}, but the builds carry the public half of key ${builds.id}`);
  });

  it('is refused when a file changed after it was signed', () => {
    const key = keyPair();
    const dir = release(key);
    appendFileSync(join(dir, 'Juno-1.2.3-mac.app.tar.gz'), 'x');
    const { ok, out } = check(dir, key.pub);
    expect(ok).toBe(false);
    expect(out).toContain('the file changed after it was signed');
  });
});
