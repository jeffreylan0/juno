# Security

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**, or by email to info@humanbn.com. Don't open a public issue. Expect an answer within a few days. Only the latest version (the newest test build, or the release once there is one) gets fixes.

## What is protected, and from whom

| What | Where it lives |
| --- | --- |
| A student's API keys (Anthropic, OpenAI) | Their own computer only, in the native core: no page of the app can read one. The core sends each only to the company that issued it. |
| A student's sign-in session | Their own computer only. It is sent only to Supabase and the Worker. |
| Chats and screenshots | Their own computer. With a plan that includes cloud storage, also Supabase, in the student's own rows and folder. |
| What an account has paid for | Stripe, which is the source of truth. The Worker mirrors it into Supabase. |
| The service's secrets: AI keys, the Supabase secret key, Stripe keys, the update signing key, signing certificates | Worker secrets, GitHub Actions secrets, and the providers' dashboards. Never in the app or the repository. |
| humanbn's money: AI spend, storage, payments | Bounded by the limits below and by spending caps the owner sets. |

The design assumes these attackers:

- **Whatever is on screen.** A web page, a document or a window title may plant instructions for the model in what is selected or in the title sent with it (prompt injection).
- **Other software or users on the computer.** This includes other users' accounts, and web pages that try to reach the app through the browser.
- **Someone on the network.**
- **Another account, or an abusive one.** For example, an account that signs up free and scripts requests.
- **A compromised dependency or build step.** For example, a package or GitHub Action that turns malicious.

The design doesn't defend against malware running as the student's own user account: it can read what that user can read, the key file included. Neither does any desktop app; the operating system is the boundary there. What limits the harm of a key stolen that way, or leaked any other way, is the key itself: one made only for Juno, in a workspace or project with a monthly spend limit, never shared (TESTERS.md, *Keep your API key safe*; the key field says so too).

## Controls, by part

**The app** (Tauri 2 security guidance; OWASP Top 10 for LLM Applications)

- **Permissions:** Screen Recording is the only OS permission, and only on macOS.
- **Model answers fetch nothing:** answers are sanitized with DOMPurify and inserted as nodes. No images, CSS `url()`, `background` attributes, SVG or MathML images, or fixed layers get through. Links open in the student's browser, only on a click.
- **API keys, by construction (src-tauri/src/vault.rs):** what keeps a key safe is how it is handled, not a promise.
  - Settings hands a key to the native core (`key_set`, Settings only) and keeps nothing; pages learn only whose it is and its last four characters (`key_status`). Whose it is comes from the key itself (`sk-ant-` Anthropic, any other `sk-` OpenAI), so a page can't file an Anthropic key under OpenAI and have it sent there; admin keys (`sk-ant-admin…`, `sk-admin-…`), which manage an organization rather than answer, are refused. The storage commands refuse to read, write or remove `keys` for every window, and never announce it.
  - Only the core can send with a key (`vendor_fetch`), and only to four endpoints: `POST /v1/messages` and `GET /v1/models` at `https://api.anthropic.com`, `POST /v1/chat/completions` and `GET /v1/models` at `https://api.openai.com`. The URL is parsed, and anything else (another host, port, path, method, query beyond `limit`, a login or fragment in the URL, plain HTTP) is refused. The client is HTTPS-only and follows no redirect, so no response can carry the key elsewhere. The key header is marked sensitive and never logged; errors name only how the request failed.
  - So even a page that was taken over (a crafted answer getting past the sanitizer, a malicious package) can't read a key or send it anywhere but to its own company, asking a question.
  - On disk: `secrets.json`, mode 0600 from the moment it is written; on Windows also encrypted for the user with DPAPI, so a copy of the file is useless on another computer or account.
  - No stray copies: once Juno has its own store, the secrets file an earlier build (Selection AI) left behind is deleted at start (`store.rs`, `adopt_earlier_store`); the earliest Windows builds kept it unencrypted in the roaming profile.
  - Tested: Rust tests pin the allowlist and the file; an end-to-end test saves a key, then tries from every window to read it (by name, with everything, straight from the native core), write it, remove it, and send it from the wrong window or to another address, and checks that each attempt fails.
- **Commands check their caller:** only the hidden core window can take a screenshot (only while the bar is up), bring up the bar, open the panel or send with a key; only the overlay steers its own pointer handling, and only the panel resizes itself. Only Settings can put a key in or remove one, start Google's sign-in listener, or change "Open at login". The overlay can't read the account session: `storage_get` refuses it, and changes to it are announced without their values (any page can listen to any event), so each window reads it back through that check.
- **Only the app's own pages, in every window:** each window refuses to navigate anywhere but the app's own pages (`wm.rs` `own_page`), so no link, whatever got it into an answer, can turn the panel into another site asking for a key. SVG and MathML links lose their `href` when an answer is sanitized, and a click on any other link opens the student's browser.
- **Network:** only the core and settings may fetch at all (`capabilities/net.json`); the bar and the panel, which show what others wrote, have no network. The HTTP allowlist covers `https://*`, plus plain HTTP to `localhost`, `127.0.0.1` and `*.local`. Nothing else is reachable, not even the cloud metadata address. API keys never go this way: only the vault sends them.
- **CSP:** `script-src 'self'`, no objects or frames, and no remote images, media or fonts.
- **Code:** no remote code, no `eval`; React's and DOMPurify's HTML-string paths are removed at build time (`desktop/harden-libs.ts`).
- **Storage:** secrets live in a file only the user's account can read (and, on Windows, encrypted for it), in local (never roaming) app data.
- **Size limits:** storage writes, screenshots and freeform outlines all have size caps.
- **Windows start-at-login:** the Run entry's path is quoted, so Windows can't run a different program planted in the install folder's parent.
- **No link scheme:** the app registers none, so no web page or other app can hand it a link.
- **Sign-in:** Google sign-in uses PKCE. Sign-out revokes the session on the server.
- **Google's return (src-tauri/src/oauth.rs, RFC 8252):** Google sends the browser back to a listener the app opens for one sign-in on `127.0.0.1` (never other addresses on the network), on a port the system picks, for ten minutes at most. It takes only `GET /?code=…` or `/?error=…`, answers with a fixed page under `default-src 'none'`, and hands the query to Settings with its port, so an older sign-in's listener isn't mistaken for this one. Settings checks the `state` it sent, and the code is useless without the PKCE verifier it kept. The ID token Google issues carries the hash of a nonce only Settings knows, and Supabase checks it. Google's error text is never shown.
- **Cloud copies:** chats already on a computer are never copied into another account that signs in there.
- **Test hook:** the test-only HTTP hook isn't compiled into releases, and it refuses any request that comes from a browser.
- **Screen capture on Windows:** the app's windows are left out of captures (display affinity) only while the app takes its own screenshot, so recordings, screen sharing and remote desktops show the app like any other window.
- **Updates (src-tauri/src/updates.rs):** a new version is installed only if its download carries a valid signature from the update key (minisign, Tauri's updater), fetched over HTTPS from the repository's `updates` release; downgrades are refused. The key's public half goes into each build (the `TAURI_UPDATER_PUBKEY` Actions variable, or `tauri.conf.json`); the private half is a GitHub Actions secret, given only to the build of a `desktop-v*` tag. A build without the public key never updates. The page code can't drive the updater: no window is granted its commands, and the app's own update commands answer only the settings window.
- **Log:** `juno.log` keeps only the app's own steps and errors (each line stripped of control characters and capped), never what was asked, the screen or a key.

**Worker** (OWASP API Security Top 10; RFC 8725 for JWT)

- **Token checks:**
  - Signatures are verified only against the project's published keys, with the algorithm pinned.
  - `iss`, `aud`, `role`, `exp` and `nbf` are checked, and the subject must be a UUID.
  - Junk tokens are refused without calling Supabase, and key refreshes are throttled.
  - Billing actions also confirm the session is still live.
- **Hosted answers** (unbounded-consumption controls):
  - Only the apps' own four models are allowed.
  - Requests are rebuilt from text and inline screenshots only.
  - Each request is capped at 100 messages, 20 images and 200,000 characters of text, and the body is capped in bytes however it is sent.
  - Each account gets at most 10 answers a minute.
  - An answer is refunded when the AI fails or can't be reached.
  - Prompt caches are scoped to one chat (see *Prompt caching* below), and the AI Gateway's response cache is skipped on every request.
- **Stripe webhook:**
  - The signature uses a timestamp tolerance and a constant-time comparison.
  - Only checkouts the Worker made give a plan.
  - Subscriptions and passes are read back fresh from Stripe, so refunds and chargebacks end a pass.
  - Events for deleted accounts are acknowledged instead of retried.
- **Google sign-in (`/auth/google`):** the Worker holds the Google client secret (a desktop app can't keep one), takes only a code meant for `http://127.0.0.1:<port>` with a well-formed PKCE verifier, and returns only the ID token: no access or refresh token for the student's Google account leaves Google. A stolen code is useless without the verifier.
- **The unlock (`/unlock/*`, no session, `worker/src/unlock.ts`):** it holds on one computer, with nothing to pass around. The app sends its computer's id (a salted SHA-256 of the system's machine id, `device.rs`: the machine id itself never leaves); the Worker puts it on the payment and, once Stripe says it is paid, signs a license for that id alone with an ECDSA P-256 key (`UNLOCK_SIGNING_KEY`, a Worker secret). The app accepts a license only if the public key built into it (`WXT_UNLOCK_KEY`) verifies it and its id is this computer's, so a license copied to another computer, or edited, opens nothing. Checkout pages are rate-limited per address; the id is checked against its exact form before it goes into a Stripe search, so it can't widen the query; a claim for another computer's checkout gets nothing; a refunded or disputed payment restores nothing. The webhook ignores unlock checkouts, so none gives an account a plan.
- **Responses:** JSON is sent `nosniff`, and the HTML pages have a strict CSP. Logs carry no prompt text.

**Prompt caching**

Anthropic and OpenAI keep a short-lived cache of a prompt's beginning, so a follow-up in the same chat does not pay for (or wait on) the screenshots again. Neither shares caches between organizations; Anthropic isolates them per workspace (since 2026-02-05), OpenAI per organization. A hit needs the same bytes from the start of the prompt, and returns faster, which is how a shared cache can leak: someone who can guess a prompt exactly can time whether somebody else sent it recently (Gu et al., *Auditing Prompt Caching in Language Model APIs*, ICML 2025).

- **Your own key:** the cache is your own organization's. Nobody else's requests can hit it, unless the key is shared (a class sharing one key shares one cache).
- **Hosted answers:** every student shares humanbn's organization and workspace. So the Worker starts each prompt with a scope of its own per chat, a hash of the account id and the chat's first question, and sends it to OpenAI as `prompt_cache_key` too. Follow-ups in a chat still hit its cache; no other chat or student can. The hash can't be reversed or linked from one chat to the next by the vendor, since the account id never leaves the Worker.
- **AI Gateway:** its response cache would hand one student the stored answer to another's identical request and keep answers at Cloudflare, so the Worker skips it on every request (`cf-aig-skip-cache`). Leave caching off in the gateway's settings too.
- **Local models:** nothing leaves the computer.

**Database** (Supabase guidance; PostgreSQL least privilege)

- **Row level security:** it is on for every table, and every privilege is stated explicitly. The result is the same whether the Data API exposes new tables or not.
- **The Worker's key** can read plans, and write Stripe customers and subscriptions. That's all.
- **Chats** are written only through functions that check cloud storage and per-account limits (`cloud_limits()`). A deletion always takes effect.
- **Screenshots:**
  - The bucket is private and holds images only, up to 5 MB each.
  - Each account has its own folder, with a cap on how many screenshots and how many bytes it may hold.
- **Account deletion** is refused while billing is still open or screenshots remain, so nothing is orphaned and nobody keeps being charged.
- **Functions:** every `SECURITY DEFINER` function pins `search_path`.

**Build and release** (OpenSSF Scorecard; SLSA)

- **Actions:** every one is pinned to a commit hash, and every workflow's token is read-only by default.
- **Credentials:** checkouts don't keep git credentials.
- **Caches:** release builds restore none.
- **Test builds:** they ship with `SHA256SUMS` and a signed build-provenance attestation.
- **Dependencies:**
  - Dependabot covers actions, npm and Cargo.
  - pnpm installs only releases at least a day old and runs no dependency install scripts.
  - `pnpm audit` and `cargo audit` were clean on 2026-10-13.
  - Each dependency earns its place (2026-10-20 review, below): what the app no longer needed was removed.

## Audit, 2026-10-13

Five parts were reviewed separately against the standards above, and every finding was checked in the code before it was fixed. The browser extension has since been retired (its code the app runs moved into `desktop/`); its rows are kept as the record. The tests cover the fixes that still apply:

- Unit tests for the Worker, sync and the renderer.
- Database checks under both Data API settings.
- Native and end-to-end tests for the app.

| Part | Finding | Severity | Fixed by |
| --- | --- | --- | --- |
| Extension (retired) | A model answer could load a URL through CSS or a `background` attribute, with no click | High | Sanitizer hooks and forbidden attributes; CSP `img-src` |
| Extension (retired) | The page could operate the bar (open shadow root, made-up events) | Medium | Closed roots; made-up events dropped |
| Extension (retired) | The background accepted every command from any sender | Medium | Sender checks; content scripts limited to selection messages |
| Extension (retired) | Keys and session readable by content scripts | Medium | Encrypted at rest with a key content scripts can't reach |
| Extension (retired) | The reader was web-accessible | Low | Opened by the background instead |
| Extension (retired) | Another account's chats could be uploaded to the next account on a shared computer | Low | Marked as another account's and never uploaded |
| Extension (retired) | Plain-HTTP service URLs possible in builds with accounts; any URL could be opened for payment | Low | The build requires https; only Stripe's pages are opened |
| Extension (retired) | Blocked sites matched only the exact hostname | Low | Subdomains and pasted URLs match, and the reader is covered too |
| Worker | No cost limit on hosted answers; the model allowlist was a pattern | High | Exact models, size caps, per-account rate limit |
| Worker | Any paid checkout on the Stripe account gave Plus | Medium | Only the Worker's own checkouts count |
| Worker | Refunds and disputes didn't reliably end a pass | Medium | Payment read back from Stripe; dispute events handled |
| Worker | Junk tokens made a call to Supabase each; a failed key fetch wiped the cached keys | Medium | Refused locally; throttled refresh; last good keys kept |
| Worker | Body size limits not enforced | Medium | Body read with a byte cap |
| Database | A free account could flood the chats table directly | High | Writes only through checked functions; per-account limits |
| Database | Deletion could orphan billing or screenshots | Medium | Refused until both are gone; sync paused meanwhile |
| Database | A subscription with no period end counted forever | Low | Counts as inactive |
| App | API keys were readable by the script of every window but the overlay, and a page sent them itself, so a page taken over could send them anywhere | Medium | The native key vault: no page reads a key; only the core sends with one, only to four endpoints at its own company |
| App | A link inside an SVG in a model's answer escaped the link handler, so a click could load another site in the panel (a lookalike asking for the key) | Medium | Windows load only the app's own pages; SVG and MathML links lose their `href`; every link click is handled |
| App | Changes to the account session went out as events with their values, which any page can hear | Low | Announced without values; read back through the checked command |
| App | Halving a long log could cut a character in two and stop the app at every start | Low | Cut at a line's end, in bytes |
| App | Any window could bring up the overlay (which allows a screenshot) or move the panel | Low | Window commands answer only their own window |
| App | Every window could call every command (capture, keys, login item) | Medium | Commands check which window called |
| App | The HTTP plugin could reach any host | Medium | Allowlist |
| App | Secrets in roaming app data on Windows | Medium | Local app data |
| App | Unquoted Run-key path; unlimited sizes; deep link showed attacker text; test hook reachable from a browser | Low | Each fixed as listed under Controls |
| Build | Store credentials reachable by the whole build; actions not pinned; caches shared with releases | High | Separate environment job; commit pins; no caches |
| Build | No token permissions set; credentials kept by checkout | Medium | Read-only by default; credentials not kept |
| Build | KaTeX advisory; dev-tool advisories (undici, sharp, source-map-js) | Low | Updated; override |
| Build | The desktop build skipped the library hardening | Info | Added |
| Build | The Firefox sources archive left out the lockfile and `shared/`, so reviewers couldn't rebuild | Low | The whole workspace minus build output; a rebuild from it is byte-identical |

## Review, 2026-10-20

After a tester lost money to someone using their API key, every way a key could leave a student's computer was traced. The app sends a key nowhere but its own company (the vault, above), and no page can read one; no path in the current code leaks it. The likely paths are outside the code: a key written into a document or message (a project document once carried a live key), a key typed into the retired browser extension or an earlier build, or other software running as the student. What changed:

| Part | Finding | Severity | Fixed by |
| --- | --- | --- | --- |
| Process | A live API key written into a project document; testers told they might be "given a key" | High | Revoke it; each tester makes their own key with a spend limit (TESTERS.md, *Keep your API key safe*; the key field says so) |
| App | An earlier build's secrets file stayed behind once Juno had its own (unencrypted on the earliest Windows builds) | Medium | Deleted at start |
| App | The bar and the panel, which show text others wrote, could fetch any `https` address | Low | Network only for the core and settings |
| App | A link scheme was registered for a second Google sign-in path through Supabase's page | Low | Path and scheme removed; Google only through the app's own client |
| App | The unlock was a code anyone could pass on | Medium (revenue) | A license signed for one computer |
| Build | 12 npm packages and 26 crates the app didn't need: the extension-era storage helper and its test fake, `dotenv`, `@types/katex`, `@playwright/test` (for `playwright-core`), `tauri-plugin-deep-link`, the HTTP plugin's cookie and charset features, a second `windows` crate; and KaTeX's WOFF and TrueType fonts (0.9 MB of the app's pages) | Info | Removed |

## Known limits (not fixed yet, and why)

- **Unsigned app builds:** the Mac build isn't notarized and the Windows build isn't signed, so testers see warnings and can't tell a genuine build from a lookalike except by its checksum or attestation. This needs an Apple Developer ID and a Windows signing certificate (see the checklist below).
- **Updates aren't pinned to a version in their signature:** the updater checks every download against the update key, but `latest.json` itself isn't signed, so someone able to serve a different `latest.json` (GitHub, or the network if TLS failed) could point apps at an older genuine release. The updater's `requireSignedVersion` closes that once the Tauri CLI that signs the releases records the version in the signature; check that, then turn it on in `tauri.conf.json`.
- **App secrets aren't encrypted at rest on macOS and Linux:** there the secrets file is protected by its permissions only (on Windows, DPAPI encrypts it too, though any program running as the same user can still ask Windows to decrypt it). Once the Mac app is signed with a Developer ID, the key can move to the Keychain, where another app reading it makes macOS ask the student first; with ad hoc signing, every build would ask for the keychain password, which is why it isn't there now.
- **Window titles go to the AI:** in the app, the title of the window under the selection goes to the AI with the selection (for example an email subject). A setting to leave it out is a product decision.
- **Email codes are the weakest sign-in:** NIST no longer treats email as a strong second channel. Google sign-in is offered. Passkeys would be the next step.
- **CAPTCHA isn't wired into sign-in yet.** Turn it on before the free plan includes hosted answers.
- **Hosted answers are counted per answer, not per token.** That holds because the Worker allows only the fast model (about $0.0005 an answer); the size caps bound one answer's cost. Bigger hosted models would need metering by cost.
- **Builds aren't reproducible:** the Rust toolchain and the runner images aren't pinned.
- **The extras are held back by the app itself** (`desktop/src/lib/extras.ts`): every theme, the bar's and panel's places, more than two macros. The app is open source, so someone who builds it can turn them on; editing its storage can't, since an unlock is a signed license for one computer. That is accepted: they cost nothing to serve. What costs money (hosted answers, cloud storage) is enforced by the Worker and the database. A license is checked on the computer, so refunding one doesn't relock the computer it was bought on, but *Restore* gives nothing for it.

## Owner's checklist

Beyond strong passwords and business accounts:

### 1. Accounts and access

- **Two addresses, two jobs:**
  - info@humanbn.com is the public face: store listings, Stripe's public details, Google's sign-in screen, the privacy policy, support, vulnerability reports.
  - The management address owns the accounts: GitHub, Cloudflare, Supabase, Stripe, Google Cloud, Apple, Microsoft, the registrar.
  - Keep the management address out of anything public: this repository, the app, store listings, email signatures and DNS. Turn on WHOIS privacy at the registrar too.
  - Publishing it makes it a phishing target: every account recovery runs through it. Ideally it also has its own strong second factor and receives nothing else.
- **Phishing-resistant two-factor everywhere:** passkeys or hardware security keys, not SMS. That means GitHub, Cloudflare, Supabase, Stripe, Google (Cloud console and Workspace), the Apple Developer account, Microsoft Partner Center, your domain registrar, and the email account that receives everyone's password resets. Keep recovery codes offline.
- **Two-factor for the whole team:** where the service allows it, require it for everyone:
  - GitHub: Organization → Authentication security.
  - Supabase: Organization → Security → *Require MFA*.
  - Stripe and Cloudflare: their team settings.
- **Your domain and email are the root of every account:**
  - Turn on registrar lock and DNSSEC.
  - Publish SPF, DKIM and DMARC for the sending domain (DMARC at `p=quarantine`, then `p=reject`).
  - Use a separate mailbox for `security@` / `support@`.
- **Least privilege for collaborators:**
  - Give people the smallest role that works (for example *Developer*, not *Owner*).
  - Use scoped API tokens, not global keys.
  - Remove access the day someone leaves, and rotate any secret they could see.
- **A separate browser profile for admin consoles,** with no extensions you don't need. Turn on full-disk encryption (FileVault or BitLocker), keep the operating system updated, and keep secrets in a password manager.

### 2. GitHub (Settings)

- **Actions → General:**
  - Workflow permissions: *Read repository contents*.
  - Untick *Allow GitHub Actions to create and approve pull requests*.
  - Require approval for workflows from outside contributors.
  - Allow only actions from GitHub and verified creators, and *require actions to be pinned to a full-length commit SHA* if the option is offered.
- **Environments:** the browser stores' `stores` environment and its nine secrets (Chrome Web Store, Firefox, Edge) belonged to the retired extension's release workflow. Delete them. Before updates are turned on (the update key's public half in the `TAURI_UPDATER_PUBKEY` variable), protect the private half: only a `desktop-v*` tag's build is given it today, but anyone who can push a tag (or a workflow) can make one. Add a tag protection rule for `desktop-v*`, then move `TAURI_SIGNING_PRIVATE_KEY` and its password into an environment (`release`) with you as required reviewer, limited to `desktop-v*` tags, and add `environment: release` to the *Test build* job. Signing certificates go there too when they arrive.
- **Rules → Rulesets:**
  - On `main`: require a pull request and the CI and Desktop checks, and block force pushes and deletion.
  - A tag ruleset so only you can create `desktop-v*` tags. Those tags publish releases.
- **Code security:**
  - Turn on Dependabot alerts and security updates.
  - Turn on secret scanning with push protection.
  - Turn on CodeQL default setup (JavaScript/TypeScript, Actions, and Rust if offered).
  - Turn on private vulnerability reporting (this file points reporters to it).
- **Optional:** sign your commits (an SSH signing key) and require signed commits on `main`.

### 3. Secrets

- **Where each one lives:**
  - The Worker's secrets: only `wrangler secret put`.
  - Never in `.env` files, chat messages, screenshots or tickets.
  - `.env.local` (at the repository root) holds only the publishable Supabase key and the service addresses.
- **The update key** (desktop/README.md, *Updates*): the private key and its password live only in your password manager and the `TAURI_SIGNING_PRIVATE_KEY*` Actions secrets. Never rotate it casually: installed copies trust only the public key they shipped with, so a new key needs one release signed with the old key that carries the new public key. If it leaks, publish nothing more with it and tell users to reinstall.
- **Rotate:** at least yearly, immediately when someone leaves, and whenever a secret might have been seen: the AI keys, the Stripe restricted key and webhook secret, the Google client secret, and the Supabase secret key. `supabase/README.md` § Before launch describes the order.
- **Cap the money:**
  - Monthly spending limits and alerts on the Anthropic and OpenAI workspaces the Worker uses.
  - Billing alerts on Cloudflare.
  - Supabase Pro's spend cap and usage alerts.
  - Stripe Radar on.
- **No shared keys for testers:** each tester makes their own, in a workspace or project of its own with a low limit (TESTERS.md). A key that was ever put in a document, a message or a screenshot (a tester guide, a PDF) is revoked at once and replaced; anyone who got the file has it.
- **The unlock's signing key:** `node worker/scripts/unlock-key.mjs` makes the pair; the private half goes only to `npx wrangler secret put UNLOCK_SIGNING_KEY` (then delete the file), the public half into the `WXT_UNLOCK_KEY` variable. If it leaks, anyone can make licenses (extras only, nothing that costs money): make a new pair, put both halves in place, and ship a build; buyers press *Restore* once.

### 4. Services: follow `supabase/README.md`, which now includes

- **Supabase:**
  - Data API on, *Automatically expose new tables* off, *automatic RLS* on.
  - 8-digit codes that expire in 10 minutes, *Confirm email* and *Secure password change* on, anonymous sign-ins off.
  - Auth rate limits, the Site URL, no redirect URLs, SSL enforced, and no direct Postgres access.
  - The Security Advisor after each migration, and backups (Pro; point-in-time recovery for production).
- **Stripe:**
  - The restricted key with only the listed permissions, and the webhook with the listed events.
  - *Cancel the subscription* after failed retries.
  - No Payment Links for Juno.
- **Cloudflare:**
  - The Worker on your own domain.
  - The rate limit in `wrangler.toml` (its `namespace_id` must be unique in the account).
  - Logs on, so failed webhooks show.
- **CAPTCHA:** before free hosted answers, turn on Cloudflare Turnstile in Supabase, and have the apps send its token (not built yet).

### 5. Releases

- **Apple Developer ID** ($99 a year): sign and notarize the Mac app (set the `APPLE_*` secrets in the build's environment). Then testers have nothing to click past, and the keys can move to the Keychain.
- **Windows code signing:** Azure Trusted Signing, or an OV or EV certificate.
- **Verify before sharing:** check a test build before you send the link. Testers who want to can run `gh attestation verify <file> --repo jeffreylan0/selectionai` or compare `SHA256SUMS`.

### 6. If something goes wrong

- **Contain:**
  - Rotate the exposed secret.
  - To end every session, rotate Supabase's JWT signing key.
  - To stop hosted answers and billing, remove the Worker's route or set its secrets to empty.
- **Assess:** check the Worker logs, Stripe's event log, and Supabase's auth audit log.
- **Fix:** ship the fix, and tell affected users what happened and what to do.
- **Notify where the law requires it:** under GDPR, the supervisory authority within 72 hours of a personal-data breach.

### 7. Privacy and legal

- **Privacy policy and terms:** `legal/privacy.md` and `legal/terms.md`, to publish at humanbn.com/privacy and /terms once the blanks are filled (`legal/README.md`) and a lawyer has read them. They must keep matching what the apps do: what is sent where, how long each processor keeps it, and that backups keep deleted accounts for their retention period.
- **Processors:** sign the data processing agreements of Supabase, Cloudflare, Stripe, Anthropic, OpenAI and the email sender.
- **Age and schools:** the terms say 13+ (COPPA). Have a FERPA-ready data agreement before schools buy.
- **Data requests:** answer access and deletion requests within 30 days. Account deletion in Settings covers deletion.
