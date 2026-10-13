# Security

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**, or by email to info@humanbn.com. Don't open a public issue. Expect an answer within a few days. Only the latest version (the store release, or the newest test build) gets fixes.

## What is protected, and from whom

| What | Where it lives |
| --- | --- |
| A student's API keys (Anthropic, OpenAI) | Their own computer only. They are sent only to the company that issued them. |
| A student's sign-in session | Their own computer only. It is sent only to Supabase and the Worker. |
| Chats and screenshots | Their own computer. With a plan that includes cloud storage, also Supabase, in the student's own rows and folder. |
| What an account has paid for | Stripe, which is the source of truth. The Worker mirrors it into Supabase. |
| The service's secrets: AI keys, the Supabase secret key, Stripe keys, store credentials | Worker secrets, GitHub environment secrets, and the providers' dashboards. Never in the apps or the repository. |
| humanbn's money: AI spend, storage, payments | Bounded by the limits below and by spending caps the owner sets. |

The design assumes these attackers:

- **A web page.** It may run scripts next to the in-page bar, or plant instructions for the model in the page title or the selected text (prompt injection).
- **Other software or users on the computer.** This includes other users' accounts and apps that try to claim the app's link (`com.humanbn.juno://`).
- **Someone on the network.**
- **Another account, or an abusive one.** For example, an account that signs up free and scripts requests.
- **A compromised dependency or build step.** For example, a package or GitHub Action that turns malicious.

The design doesn't defend against malware running as the student's own user account. Neither does any browser extension or desktop app; the operating system is the boundary there.

## Controls, by part

**Browser extension** (Chrome MV3 security guidance; OWASP Top 10 for LLM Applications)

- **Permissions and code:** it asks for `activeTab`, `scripting`, `storage` and `sidePanel`, plus `identity` only in builds with accounts. It has no host permissions, loads no remote code and never calls `eval`.
- **Model answers fetch nothing:** answers are sanitized with DOMPurify. No images, CSS `url()`, `background` attributes, SVG or MathML images, or fixed layers get through.
- **CSP:** the extension pages refuse remote images, media and fonts, and allow no `object` elements.
- **Locked-down bar:** the in-page bar lives in a closed shadow root and ignores events a page's scripts make up.
- **Message checks:** content scripts may send the background only messages about the selection. Chats, keys, settings and the account answer only the extension's own pages.
- **Reader:** the PDF reader isn't web-accessible.
- **Keys and session encrypted at rest:** they are encrypted (sealed) with AES-GCM under a key that lives only in the extension's own IndexedDB.
- **Sign-in:** Google sign-in uses PKCE. Sign-out revokes the session on the server.
- **Cloud copies:** chats already on a computer are never copied into another account that signs in there.

**Desktop app** (Tauri 2 security guidance)

- **Permissions:** Screen Recording is the only OS permission, and only on macOS.
- **Commands check their caller:** only the hidden core window can take a screenshot, and only while the bar is up. The overlay can't read or change keys. Only Settings can change "Open at login".
- **Network:** the HTTP allowlist covers `https://*`, plus plain HTTP to `localhost`, `127.0.0.1` and `*.local`. Nothing else is reachable, not even the cloud metadata address.
- **CSP:** `script-src 'self'`, no objects or frames, and no remote images.
- **Storage:** secrets live in a file only the user's account can read, in local (never roaming) app data.
- **Size limits:** storage writes, screenshots and freeform outlines all have size caps.
- **Windows start-at-login:** the Run entry's path is quoted, so Windows can't run a different program planted in the install folder's parent.
- **Deep links:** they are accepted only while a sign-in is pending, and show only fixed text.
- **Test hook:** the test-only HTTP hook isn't compiled into releases, and it refuses any request that comes from a browser.

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
- **Stripe webhook:**
  - The signature uses a timestamp tolerance and a constant-time comparison.
  - Only checkouts the Worker made give a plan.
  - Subscriptions and passes are read back fresh from Stripe, so refunds and chargebacks end a pass.
  - Events for deleted accounts are acknowledged instead of retried.
- **Responses:** JSON is sent `nosniff`, and the one HTML page has a strict CSP. Logs carry no prompt text.

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
- **Store credentials:** they live in a separate `stores` environment job, which runs only install and submit.
- **Test builds:** they ship with `SHA256SUMS` and a signed build-provenance attestation.
- **Dependencies:**
  - Dependabot covers actions, npm and Cargo.
  - pnpm installs only releases at least a day old and runs no dependency install scripts.
  - `pnpm audit` and `cargo audit` were clean on 2026-10-13.

## Audit, 2026-10-13

Five parts were reviewed separately against the standards above, and every finding was checked in the code before it was fixed. The tests cover the fixes:

- Unit tests for the Worker, sealing, blocked sites, sync and the renderer.
- Database checks under both Data API settings.
- Browser end-to-end tests, including made-up page events.
- Native tests for the app.

| Part | Finding | Severity | Fixed by |
| --- | --- | --- | --- |
| Extension | A model answer could load a URL through CSS or a `background` attribute, with no click | High | Sanitizer hooks and forbidden attributes; CSP `img-src` |
| Extension | The page could operate the bar (open shadow root, made-up events) | Medium | Closed roots; made-up events dropped |
| Extension | The background accepted every command from any sender | Medium | Sender checks; content scripts limited to selection messages |
| Extension | Keys and session readable by content scripts | Medium | Encrypted at rest with a key content scripts can't reach |
| Extension | The reader was web-accessible | Low | Opened by the background instead |
| Extension | Another account's chats could be uploaded to the next account on a shared computer | Low | Marked as another account's and never uploaded |
| Extension | Plain-HTTP service URLs possible in builds with accounts; any URL could be opened for payment | Low | The build requires https; only Stripe's pages are opened |
| Extension | Blocked sites matched only the exact hostname | Low | Subdomains and pasted URLs match, and the reader is covered too |
| Worker | No cost limit on hosted answers; the model allowlist was a pattern | High | Exact models, size caps, per-account rate limit |
| Worker | Any paid checkout on the Stripe account gave Plus | Medium | Only the Worker's own checkouts count |
| Worker | Refunds and disputes didn't reliably end a pass | Medium | Payment read back from Stripe; dispute events handled |
| Worker | Junk tokens made a call to Supabase each; a failed key fetch wiped the cached keys | Medium | Refused locally; throttled refresh; last good keys kept |
| Worker | Body size limits not enforced | Medium | Body read with a byte cap |
| Database | A free account could flood the chats table directly | High | Writes only through checked functions; per-account limits |
| Database | Deletion could orphan billing or screenshots | Medium | Refused until both are gone; sync paused meanwhile |
| Database | A subscription with no period end counted forever | Low | Counts as inactive |
| App | Every window could call every command (capture, keys, login item) | Medium | Commands check which window called |
| App | The HTTP plugin could reach any host | Medium | Allowlist |
| App | Secrets in roaming app data on Windows | Medium | Local app data |
| App | Unquoted Run-key path; unlimited sizes; deep link showed attacker text; test hook reachable from a browser | Low | Each fixed as listed under Controls |
| Build | Store credentials reachable by the whole build; actions not pinned; caches shared with releases | High | Separate environment job; commit pins; no caches |
| Build | No token permissions set; credentials kept by checkout | Medium | Read-only by default; credentials not kept |
| Build | KaTeX advisory; dev-tool advisories (undici, sharp, source-map-js) | Low | Updated; override |
| Build | The desktop build skipped the library hardening | Info | Added |
| Build | The Firefox sources archive left out the lockfile and `shared/`, so reviewers couldn't rebuild | Low | The whole workspace minus build output; a rebuild from it is byte-identical |

## Known limits (not fixed yet, and why)

- **Unsigned app builds:** the Mac build isn't notarized and the Windows build isn't signed, so testers see warnings and can't tell a genuine build from a lookalike except by its checksum or attestation. This needs an Apple Developer ID and a Windows signing certificate (see the checklist below).
- **No auto-updater:** a security fix reaches app users only when they reinstall. Add Tauri's updater, with its own signing key kept offline, once builds are signed.
- **App secrets aren't encrypted at rest:** the app's secrets file is protected only by file permissions. Once the app is signed, keep the key in the macOS Keychain or under Windows DPAPI.
- **Chat text in the extension:** keys and the session are encrypted, but saved chats' text in `storage.local` isn't, so a page that broke out of its sandbox could read them.
- **Window titles go to the AI:** in the app, the title of the window under the selection goes to the AI with the selection (for example an email subject). A setting to leave it out is a product decision.
- **Email codes are the weakest sign-in:** NIST no longer treats email as a strong second channel. Google sign-in is offered. Passkeys would be the next step.
- **CAPTCHA isn't wired into sign-in yet.** Turn it on before the free plan includes hosted answers.
- **Hosted answers are counted per answer, not per token.** The size caps bound one answer's cost, but metering tokens would be fairer before free hosted answers are raised.
- **Builds aren't reproducible:** the Rust toolchain and the runner images aren't pinned.

## Owner's checklist

Beyond strong passwords and business accounts:

### 1. Accounts and access

- **Two addresses, two jobs:**
  - info@humanbn.com is the public face: store listings, Stripe's public details, Google's sign-in screen, the privacy policy, support, vulnerability reports.
  - The management address owns the accounts: GitHub, Cloudflare, Supabase, Stripe, Google Cloud, Apple, the stores, the registrar.
  - Keep the management address out of anything public: this repository, the apps, store listings, email signatures and DNS. Turn on WHOIS privacy at the registrar too.
  - Publishing it makes it a phishing target: every account recovery runs through it. Ideally it also has its own strong second factor and receives nothing else.
- **Phishing-resistant two-factor everywhere:** passkeys or hardware security keys, not SMS. That means GitHub, Cloudflare, Supabase, Stripe, Google (Cloud console and Workspace), the Apple Developer account, the Chrome Web Store, addons.mozilla.org, Microsoft Partner Center, your domain registrar, and the email account that receives everyone's password resets. Keep recovery codes offline.
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
- **Environments → New environment `stores`:**
  - Required reviewer: you.
  - Deployment rule: tags `v*` only.
  - Move the nine store secrets there (`release.yml` reads them from it), then delete the repository-level copies.
- **Rules → Rulesets:**
  - On `main`: require a pull request and the CI and Desktop checks, and block force pushes and deletion.
  - A tag ruleset so only you can create `v*` and `desktop-v*` tags. Those tags publish releases.
- **Code security:**
  - Turn on Dependabot alerts and security updates.
  - Turn on secret scanning with push protection.
  - Turn on CodeQL default setup (JavaScript/TypeScript, Actions, and Rust if offered).
  - Turn on private vulnerability reporting (this file points reporters to it).
- **Optional:** sign your commits (an SSH signing key) and require signed commits on `main`.

### 3. Secrets

- **Where each one lives:**
  - The Worker's secrets: only `wrangler secret put`.
  - The store credentials: only the `stores` environment.
  - Never in `.env` files, chat messages, screenshots or tickets.
  - `extension/.env.local` holds only the publishable Supabase key and the service addresses.
- **Rotate:** at least yearly, immediately when someone leaves, and whenever a secret might have been seen: the AI keys, the Stripe restricted key and webhook secret, the Supabase secret key, and the store credentials. `supabase/README.md` § Before launch describes the order.
- **Cap the money:**
  - Monthly spending limits and alerts on the Anthropic and OpenAI workspaces the Worker uses.
  - Billing alerts on Cloudflare.
  - Supabase Pro's spend cap and usage alerts.
  - Stripe Radar on.
- **A key for testers:** make it in its own workspace with a low limit, and revoke it when testing ends.

### 4. Services: follow `supabase/README.md`, which now includes

- **Supabase:**
  - Data API on, *Automatically expose new tables* off, *automatic RLS* on.
  - 8-digit codes that expire in 10 minutes, *Confirm email* and *Secure password change* on, anonymous sign-ins off.
  - Auth rate limits, the Site URL, exact redirect URLs, SSL enforced, and no direct Postgres access.
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
- **Store accounts:** two-factor on each. In the Chrome Web Store, turn on verified uploads if offered.

### 6. If something goes wrong

- **Contain:**
  - Rotate the exposed secret.
  - To end every session, rotate Supabase's JWT signing key.
  - To stop hosted answers and billing, remove the Worker's route or set its secrets to empty.
- **Assess:** check the Worker logs, Stripe's event log, and Supabase's auth audit log.
- **Fix:** ship the fix, and tell affected users what happened and what to do.
- **Notify where the law requires it:** under GDPR, the supervisory authority within 72 hours of a personal-data breach.

### 7. Privacy and legal

- **Privacy policy:** it must match what the apps do: what is sent where, how long each processor keeps it, and that backups keep deleted accounts for their retention period.
- **Processors:** sign the data processing agreements of Supabase, Cloudflare, Stripe, Anthropic and OpenAI.
- **Age and schools:** set 13+ in the terms (COPPA). Have a FERPA-ready data agreement before schools buy.
- **Data requests:** answer access and deletion requests within 30 days. Account deletion in Settings covers deletion.
