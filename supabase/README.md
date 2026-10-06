# Accounts, cloud storage and hosted answers: setup

Builds without these settings have no accounts at all (no Account section, no `identity` permission, nothing sent anywhere but the AI the student picks). Everything below is needed only to turn accounts on.

What each piece does:

| Piece | Used for | Needed for |
| --- | --- | --- |
| Supabase project | sign-in (Google, email code), `entitlements`, cloud `chats`, `screenshots` bucket, hosted-answer `usage` | accounts, cloud storage |
| Google Cloud OAuth client | "Continue with Google" | Google sign-in only |
| An SMTP provider | sending the 6-digit sign-in codes | email sign-in for anyone outside your Supabase team |
| Cloudflare Worker (`worker/`) | hosted answers with your AI key, counted per account | hosted answers only |

Nobody gets cloud storage or hosted answers until you give it to them (step 7).

## 1. Supabase project

1. Create a project at supabase.com (the free plan is enough to start: 500 MB database, 1 GB file storage, 50,000 monthly users; a free project pauses after a week without traffic).
2. **Project Settings → API Keys**: note the project URL (`https://<ref>.supabase.co`), the **publishable** key (`sb_publishable_…`, goes in the extension) and the **secret** key (`sb_secret_…`, only ever in the Worker).
3. **SQL Editor**: paste all of `migrations/20261006000000_accounts.sql` and run it. It is safe to run again after an update.

## 2. Email codes

1. **Authentication → Sign In / Providers → Email**: enabled; *Email OTP length* 6 (the extension accepts 6–10); *Email OTP expiration* 3600 s or less.
2. **Authentication → Emails → Templates**: in both **Magic link** and **Confirm signup**, put the code in the message, for example:

   ```html
   <h2>Your Selection AI code</h2>
   <p>Enter this code in Selection AI's settings: <strong>{{ .Token }}</strong></p>
   <p>It works once and expires within an hour. If you didn't ask for it, ignore this email.</p>
   ```

   Without `{{ .Token }}` the email carries only a link, which the extension does not use.
3. **Authentication → Emails → SMTP Settings**: set up a real sender (Resend, Postmark, Amazon SES, …). Supabase's built-in sender only delivers to members of your Supabase team and only a couple of emails an hour.

## 3. Google sign-in

1. In Google Cloud Console, **Google Auth Platform → Branding/Audience**: an External app with your app name and support email; scopes `openid`, `email`, `profile`. While it is in *Testing*, only test users you list can sign in; publish it for everyone.
2. **Clients → Create client → Web application**. Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`.
3. In Supabase, **Authentication → Sign In / Providers → Google**: enable, paste the client ID and secret.

## 4. Redirect URLs

The browser sends Google sign-in back to the extension itself, and Supabase only allows addresses on its list. **Authentication → URL Configuration → Redirect URLs**, add:

| Browser | Redirect URL |
| --- | --- |
| Chrome and Edge (unpacked builds, fixed id `bipacelfiohnnmfkhfhkjblblkediabm`) | `https://bipacelfiohnnmfkhfhkjblblkediabm.chromiumapp.org/**` |
| Firefox (add-on id `selection-ai@amcpmn.org`) | `https://a4e8428dd16907c97dcf8cc48607ef628c93e7e4.extensions.allizom.org/**` |
| Chrome Web Store (once listed) | `https://<store id>.chromiumapp.org/**` |

Use these exact addresses, not a wildcard such as `https://*.chromiumapp.org/**`: a wildcard lets any extension receive your users' sign-in codes. To double-check the Firefox one, open `about:debugging` → *Inspect* on the add-on and run `browser.identity.getRedirectURL()` in its console.

Safari has no `identity` API; there, email codes are the way in.

## 5. Build the extension with accounts

Create `extension/.env.local` (gitignored):

```bash
WXT_SUPABASE_URL=https://<ref>.supabase.co
WXT_SUPABASE_KEY=sb_publishable_...
# WXT_GATEWAY_URL=https://selection-ai.<account>.workers.dev   # step 8, hosted answers
```

Then build as usual (`pnpm --filter extension zip`, `zip:firefox`). The publishable key is public by design; row level security is what protects each account's data.

Builds with accounts carry the manifest `key` in `extension/brand.ts`, which fixes the Chrome id so Google can send people back. **That changes the id once** for anyone who loaded an earlier unpacked build: Chrome treats it as a new extension, with empty settings and no chats. Chrome Web Store builds leave the key out (`STORE=1`); the store assigns its own id, whose redirect URL goes on the list in step 4. The private half of the key is kept outside the repo and is only needed to pack a `.crx`.

## 6. What students see

Settings → **Account**: *Continue with Google*, or an email address and *Email me a code*. Signed in, the section shows the address, *Sign out*, cloud storage if the account has it (*Keep my chats in the cloud too*, off until they turn it on, with a sync status line), hosted answers left this month if their plan has any, and *Delete account*.

Cloud storage copies saved chats and their screenshots both ways; temporary chats never go. The newer version of a chat wins. The chat limit only removes chats from that computer (the account keeps them); deleting a chat, or *Delete all chats*, deletes it everywhere. The first account to sign in on a computer gets that computer's existing chats uploaded; a different account signing in later does not. *Delete account* removes the screenshots, the cloud chats and the account; chats on the computer stay.

## 7. Giving an account cloud storage or a plan

The person signs in once (that creates the account). Then, in the SQL Editor:

```sql
select public.set_entitlement('friend@example.com');                       -- cloud storage
select public.set_entitlement('friend@example.com', true, 'student');      -- and 600 hosted answers a month
select public.set_entitlement('friend@example.com', true, 'student', 50);  -- and 50 a month instead
select public.set_entitlement('friend@example.com', false);                -- take it all away
```

Their settings page picks the change up the next time it opens.

## 8. Hosted answers (the Worker)

Hosted answers let a signed-in student with a plan ask without a key of their own: the extension sends the request to the Worker with the student's session token; the Worker checks the token against the project's published signing keys, counts one answer (`use_answer`, refunded if the AI fails), and asks Anthropic or OpenAI with your key. It answers in the same stream format as the vendors, so the extension reads it the same way. Only Claude Haiku/Sonnet and GPT models are allowed through. Nothing is stored; with an AI Gateway, its logging is switched off on every request.

```bash
cd worker
npx wrangler login
npx wrangler secret put SUPABASE_URL          # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_SECRET_KEY   # sb_secret_...
npx wrangler secret put ANTHROPIC_API_KEY     # a key from a separate Anthropic workspace with a monthly spend limit
npx wrangler secret put OPENAI_API_KEY        # optional
npx wrangler deploy
```

Put the printed `https://selection-ai.<account>.workers.dev` in `WXT_GATEWAY_URL` (step 5) and rebuild. Students whose plan includes answers then see **Hosted** under Settings → Answers and in the panel's model picker.

Billing is not built. `worker/src/stripe.ts` already maps Stripe's subscription events to `entitlements.plan`; what remains is a Checkout Session created with `client_reference_id` set to the student's user id, a price, and the webhook endpoint `https://<worker>/stripe/webhook` with `STRIPE_WEBHOOK_SECRET`.

## Checking the schema locally

`supabase/tests/run.sh` runs the migration twice on a throwaway local PostgreSQL database (with small stand-ins for Supabase's `auth` and `storage` schemas) and checks the rules: own rows only, cloud storage needed to save but never to delete, last write wins, quotas counted atomically, account deletion cascading.
