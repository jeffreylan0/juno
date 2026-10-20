// The unlock's signing key pair (src/unlock.ts). The private half becomes
// the Worker's UNLOCK_SIGNING_KEY secret and never goes into this
// repository or a build; the public half goes into every build (the
// WXT_UNLOCK_KEY Actions variable), where the app checks licenses with it.
//
//   node scripts/unlock-key.mjs
//   npx wrangler secret put UNLOCK_SIGNING_KEY < unlock-signing-key.json
//   rm unlock-signing-key.json
import { writeFileSync } from 'node:fs';

const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
writeFileSync('unlock-signing-key.json', JSON.stringify(await crypto.subtle.exportKey('jwk', privateKey)), { mode: 0o600, flag: 'wx' });
const pub = Buffer.from(await crypto.subtle.exportKey('raw', publicKey)).toString('base64url');
console.log(`Private half: unlock-signing-key.json (put it with wrangler, then delete it).
Public half, for the WXT_UNLOCK_KEY Actions variable and .env.local:
${pub}`);
