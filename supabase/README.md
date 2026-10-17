# Accounts, cloud storage and subscriptions: setup

Everything on the coding side is built: sign-in (Google, or a code sent by email), the cloud copy of chats, hosted answers, plans and Stripe billing, the account dashboard in the app's Settings. What remains is setting up the services below, in this order. Builds made without these settings have no accounts at all: no Account section, nothing sent anywhere but the AI the student picks.

## How it fits together

```
 app ──sign in──────────────────────────▶ Supabase Auth ──▶ session token (kept on the computer)
        │  ─────my_account, chats, screenshots (row level security)──▶ Supabase database + storage
        │
        └──── token ───▶ Cloudflare Worker ──▶ Anthropic / OpenAI   (hosted answers, counted per plan)
                               │      ▲
                     checkout, portal │ webhook (signed)
                               ▼      │
                              Stripe ─┘ ──▶ the Worker writes subscriptions into Supabase
```

- **Supabase** is who the student is and what they keep: accounts, plans, the cloud copy of chats and screenshots, hosted answers counted per month.
- **Stripe** is the only source of truth for who pays. Its webhook tells the Worker; the Worker reads the subscription back from Stripe (so late or out-of-order events never leave an old state) and saves it in `subscriptions`.
- **The Worker** holds every secret the apps must not: the AI keys, the Supabase secret key, the Stripe key. The apps hold only the student's own session.
- **What an account gets** is worked out in one place, the database function `account_of()`: the free plan, plus anything you gave the account by hand (`set_entitlement`), plus what it pays for. The most generous wins. Row level security (cloud storage), the Worker's count (hosted answers) and the Account section all read it.
- **Bring-your-own-key and local models never touch any of this**: they work signed out, and the keys stay on the computer (see *How keys are stored* in the main README).

| Piece | Used for |
| --- | --- |
| Supabase project | sign-in, plans, the cloud copy, hosted-answer counts |
| An email sender (SMTP) | the 6-digit sign-in codes |
| Google Cloud OAuth client | "Continue with Google" |
| Cloudflare Worker (`worker/`) | hosted answers, Stripe checkout, portal and webhook |
| Stripe account | plans, payment, invoices, tax |
| A domain (recommended) | the email sender (SPF/DKIM), the Worker's address, the privacy policy |

Before starting, have ready: the business's legal details for Stripe (humanbn, its address, a bank account for payouts, a tax id), the outward contact address (info@humanbn.com: support, the stores, Stripe, Google's sign-in screen), and a privacy policy and terms of service at public URLs (for example `https://humanbn.com/privacy` and `https://humanbn.com/terms`). Open every service account below with the management address instead, which never appears in the apps, the store listings or this public repository (Stripe and the stores ask for them).

## 1. Supabase project

1. Create a project at supabase.com, in the region nearest your students. The free plan is enough to start (500 MB database, 1 GB storage, 50,000 monthly users), but it pauses after a week without traffic and has no backups: move to Pro before launch. Under **Security**:
   - **Enable Data API**: on. The apps and the Worker reach the database through it.
   - **Automatically expose new tables**: off, as Supabase recommends. The migration grants each role exactly what it uses, so nothing else is reachable.
   - **Enable automatic RLS**: on. A safety net for tables you add later; the migration already turns row level security on for every table.

   A project made with the other choices works the same: the migration states every privilege itself.
2. **Project Settings → API Keys**: note the project URL (`https://<ref>.supabase.co`), the **publishable** key (`sb_publishable_…`, goes in the apps) and the **secret** key (`sb_secret_…`, only ever in the Worker).
3. **SQL Editor**: paste all of `migrations/20261006000000_accounts.sql` and run it. It is safe to run again after an update, and brings a project made from an earlier version of the file up to date.
4. **Table Editor → plans**: the three plans it made. `free` is every signed-in account (0 hosted answers, no cloud storage); `plus` is the paid plan (600 hosted answers a month, cloud storage); `unlimited` is for you and testers. Change the numbers here at any time: they apply at once. The round-9 pricing proposal gives `free` about 30 hosted answers a month; leave it at 0 until the abuse protection in step 10 is on, since email sign-up is free.

## 2. Email codes

1. **Authentication → Sign In / Providers → Email**: enabled; *Email OTP length* **8** (the apps accept 6–10; each digit makes guessing ten times harder); *Email OTP expiration* **600** s (10 minutes, NIST SP 800-63B's limit for a one-time code); *Confirm email* on; *Secure password change* on. The apps never use passwords: leave *Allow new users to sign up* on (codes create accounts) but don't add a password sign-in anywhere. **Allow anonymous sign-ins** stays off.
   **Authentication → Rate Limits**: keep the defaults or lower them: emails sent per hour (codes), token verifications per 5 minutes per IP, token refreshes. They are what stops someone guessing codes or burning your email quota.
2. **Authentication → Emails → Templates**: in both **Magic link** and **Confirm signup**, put the code in the message, for example:

   ```html
   <h2>Your Juno code</h2>
   <p>Enter this code in Juno's settings: <strong>{{ .Token }}</strong></p>
   <p>It works once and expires within an hour. If you didn't ask for it, ignore this email.</p>
   ```

   Without `{{ .Token }}` the email carries only a link, which the apps do not use. Add a line such as *Never share this code. Juno will never ask you for it.*: a code is the whole sign-in.
3. **Authentication → Emails → SMTP Settings**: a real sender (Resend, Postmark, Amazon SES, …), sending as `Juno <info@humanbn.com>` (or a `no-reply@humanbn.com` that replies go nowhere from) with humanbn.com's SPF, DKIM and DMARC records set. Supabase's built-in sender only reaches members of your Supabase team, a few emails an hour.

## 3. Google sign-in

1. Google Cloud Console → **Google Auth Platform → Branding / Audience**: an External app named Juno, with info@humanbn.com as the support email, the privacy policy and terms URLs, and `humanbn.com` as an authorized domain; scopes `openid`, `email`, `profile`. While it is in *Testing* only the test users you list can sign in; publish it for everyone (basic scopes need no review).
2. **Clients → Create client → Web application**. Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`.
3. Supabase → **Authentication → Sign In / Providers → Google**: enable, paste the client ID and secret.

## 4. Redirect URLs

Supabase only sends a sign-in back to addresses on its list. **Authentication → URL Configuration**: set **Site URL** to your own site (`https://humanbn.com`), not the default `http://localhost:3000`: Supabase falls back to it for a redirect it doesn't recognise. Then **Redirect URLs**, add:

| Where | Redirect URL |
| --- | --- |
| The app (macOS, Windows) | `com.humanbn.juno://auth/callback` |

Use this exact address, not a wildcard. It is safe to list: sign-in uses PKCE, so a code that reached another program would be useless without the secret the app kept. If the list still has the retired browser extension's addresses (`…chromiumapp.org/**`, `…extensions.allizom.org/**`), remove them.

In the app, *Continue with Google* opens Google in the student's browser; at the end the browser asks to open Juno, and the app finishes signing in. macOS learns the `com.humanbn.juno://` link from the app bundle (`pnpm app` or a release build, not `pnpm dev`); Windows registers it when the app first runs.

Safari has no `identity` API: there, email codes are the way in.

## 5. The Worker

```bash
cd worker
npx wrangler login
npx wrangler secret put SUPABASE_URL          # https://<ref>.supabase.co
npx wrangler secret put SUPABASE_SECRET_KEY   # sb_secret_...
npx wrangler secret put ANTHROPIC_API_KEY     # from a separate Anthropic workspace, with a monthly spend limit
npx wrangler secret put OPENAI_API_KEY        # optional, the same way
npx wrangler deploy
```

It prints `https://juno.<account>.workers.dev`. Better, give it your own address: Cloudflare → Workers → juno → **Settings → Domains & Routes → Add custom domain** (`api.humanbn.com`). That address is the apps' `WXT_GATEWAY_URL` (step 7) and Stripe's webhook (step 6).

Optional: an **AI Gateway** named `juno` (Cloudflare → AI → AI Gateway) gives rate limits and spend analytics; put your Cloudflare account id in `AI_GATEWAY_ID` in `wrangler.toml` and deploy again. Logging and the response cache are switched off on every request; leave *Cache responses* off in the gateway's settings as well (SECURITY.md, *Prompt caching*).

## 6. Stripe

Do all of this in **test mode** first (the toggle at the top of the dashboard), try it end to end, then repeat the starred steps in live mode.

1. **Activate the account** for humanbn: business details, bank account, and under **Settings → Public details** the name students see (Juno), info@humanbn.com as the support email, and the privacy policy and terms URLs. **Settings → Branding**: icon and colours (the checkout page uses them).
2. ★ **The product and its prices** (Product catalog → Add product): *Juno Plus*, with metadata `plan` = `plus`. Add three prices, each with a **lookup key** (under *More options*):

   | Price | Type | Lookup key | Metadata |
   | --- | --- | --- | --- |
   | $7.99 a month | Recurring, monthly | `plus_monthly` | |
   | $59.99 a year | Recurring, yearly | `plus_yearly` | |
   | $24.99 for a semester | One-time | `plus_semester` | `pass_days` = `120` |

   The apps show whatever prices these keys name, in the order of `STRIPE_PRICES` in `worker/wrangler.toml`. To change a price later, make a new price and move the lookup key to it (*Transfer lookup key*); students already subscribed keep theirs. A one-time price is a pass: Plus for `pass_days` days, no renewal.
3. **Settings → Billing → Customer portal**: allow *Update payment methods*, *View invoice history* and *Cancel subscriptions* (at the end of the period); under *Subscriptions → Customers can switch plans*, add the monthly and yearly prices. Save.
4. **Settings → Billing → Subscriptions and emails**: turn on Smart Retries, and the emails for failed payments and expiring cards, so a declined card is retried before anything ends. Set what happens *if all retries for a payment fail* to **Cancel the subscription** (not "leave it past due", which would keep Plus on unpaid for a whole period). (While Stripe retries, the account keeps Plus and Settings tells the student to update their card.)
5. **Tax**: Stripe Tax (**Tax → Set up**) registers where you must collect sales tax or VAT and adds it at checkout; then set `STRIPE_TAX = "on"` in `worker/wrangler.toml` and deploy. If you would rather not handle sales tax and VAT registrations yourself, a merchant of record (Paddle, Lemon Squeezy) does it for a larger fee, but that would replace `worker/src/billing.ts`; decide before launch.
6. ★ **A restricted API key** (Developers → API keys → Create restricted key), with only: *Customers* write, *Checkout Sessions* write, *Customer portal* write, *Prices* read, *Products* read, *Subscriptions* read, *PaymentIntents* read, *Charges* read (the last two so a pass's payment is read back from Stripe: refunded or disputed passes end). Then `npx wrangler secret put STRIPE_SECRET_KEY`.
7. ★ **The webhook** (Developers → Webhooks → Add endpoint): `https://<your Worker>/stripe/webhook`, sending `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `charge.refunded`, `charge.dispute.created` and `charge.dispute.closed`. Don't make Payment Links or other Checkout integrations on this Stripe account for Juno: the Worker gives a plan only for checkouts it made itself, so those would take payment and give nothing. Copy its signing secret: `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
8. **Try it** (test mode): sign in to a test build, Settings → Account → *$7.99 a month*, pay with card `4242 4242 4242 4242` (any future date, any CVC). Back in Settings, the plan line says *Plus · Renews on …*, hosted answers show 600 left, and cloud storage can be turned on. In Supabase, `subscriptions` has the row. *Manage billing* opens the portal; cancel there and Settings says *Ends on …*. Try the semester price too, and a declined card (`4000 0000 0000 0341`) to see *Your last payment didn't go through*.
9. **Go live**: switch the dashboard to live mode, repeat the starred steps (live prices, live restricted key, live webhook and its secret), and `wrangler secret put` the live values over the test ones.

What happens when:

- **A student cancels** (portal): Plus stays until the period ends, then the account is on Free. Their cloud chats stay; new ones are no longer copied up.
- **A payment fails**: Stripe retries for a while (step 4) and the account keeps Plus meanwhile; if every retry fails, the subscription ends and the account is on Free.
- **You refund** a pass in full (Payments → Refund): it ends at once. A subscription refunded in the dashboard is not cancelled by the refund: cancel it there too.
- **A student deletes their account**: the Worker deletes their Stripe customer first, which ends any subscription at once (no refund), then the account and its cloud copy go. Stripe keeps its own records of past payments, as the law requires.

## 7. Build the app with accounts

Create `.env.local` at the root of the repository (gitignored):

```bash
WXT_SUPABASE_URL=https://<ref>.supabase.co
WXT_SUPABASE_KEY=sb_publishable_...
WXT_GATEWAY_URL=https://api.<your domain>      # the Worker (step 5)
```

Then build as usual (`pnpm build`). The publishable key is public by design; row level security protects each account's data.

## 8. Giving an account a plan by hand

For you, testers and anyone you want to give something to. The person signs in once (that creates the account); then, in the SQL Editor:

```sql
select public.set_entitlement('friend@example.com');                    -- cloud storage
select public.set_entitlement('friend@example.com', true, 'plus');      -- and Plus's hosted answers
select public.set_entitlement('friend@example.com', true, 'plus', 50);  -- and 50 a month instead
select public.set_entitlement('friend@example.com', false);             -- take it all away
```

This never touches what they pay for, and what they pay for never undoes it: the most generous of the two applies. Their Settings pick the change up the next time they open.

## 9. What students see

Settings → **Account**: *Continue with Google*, or an email address and *Email me a code*. Signed in, the section is the account's dashboard:

- **Plan**: its name and what is next for it (*Renews on …*, *Ends on …*, *Until …* for a pass, or that a payment failed), hosted answers left this month with a meter, the prices on offer when the account pays for nothing (*$7.99 a month*, …), and *Manage billing* (Stripe's portal: card, invoices, switching, cancelling) once it has paid.
- **Cloud storage**, when the plan includes it: *Keep my chats in the cloud too*, off until they turn it on, with a sync status line.
- **Delete account**, which says when a subscription would end with it.

Payment opens in the student's browser; card details never pass through the apps. Settings read the account again whenever they come back into view, so a payment shows within seconds of the student returning.

Cloud storage copies saved chats and their screenshots both ways; temporary chats never go. The newer version of a chat wins. The chat limit only removes chats from that computer (the account keeps them); deleting a chat, or *Delete all chats*, deletes it everywhere. The first account to sign in on a computer gets that computer's existing chats uploaded; a different account signing in later does not.

## 10. Before launch

- **Legal**: privacy policy (what is stored, where, for how long; who processes it: Supabase, Cloudflare, Stripe, Anthropic, OpenAI), terms of service with the refund policy, and 13+ in the terms (COPPA); a data agreement path if schools buy (FERPA). Any app store's data disclosures must match.
- **Abuse**: free accounts are one email away. Before giving `free` any hosted answers, turn on **Authentication → Attack Protection → CAPTCHA** (Cloudflare Turnstile) in Supabase (the apps' sign-in will need to pass the token: a small change, not built yet) and rate limits in the AI Gateway. The Worker already limits each account to 10 hosted answers a minute and refuses requests bigger than a long chat (`worker/src/models.ts`); the database caps what one account may keep in the cloud (`cloud_limits()` in the migration: 5,000 chats, 20,000 screenshots).
- **Database**: **Project Settings → Database → SSL Configuration**: *Enforce SSL* on. **Network Restrictions**: the apps and the Worker use only the Data API, so allow direct Postgres connections from nowhere (or only your own address while you work). **Advisors → Security Advisor**: run it after every migration; it should flag nothing but the functions signed-in students are meant to call (`my_account`, `push_chats`, `delete_all_chats`, `delete_me`, `has_cloud`, `screenshot_room`), which check `auth.uid()` themselves.
- **Money**: a monthly spend limit on the Anthropic and OpenAI workspaces the Worker uses; Stripe Radar's default rules on.
- **Operations**: Supabase Pro (daily backups) and its usage alerts; the Worker's logs (Cloudflare → Workers → juno → Logs) for failed webhooks; Stripe → Developers → Webhooks shows every delivery and can resend one.
- **Keys**: rotate any secret that was ever pasted anywhere but `wrangler secret put` and the Supabase dashboard. The Worker's secret key is all-powerful outside the tables it was granted (Supabase Auth's admin API, every screenshot): if it may have leaked, make a new one in **Project Settings → API Keys**, `wrangler secret put SUPABASE_SECRET_KEY`, then delete the old one. The same for the Stripe restricted key and webhook secret, and the AI keys.
- **Privacy policy**: say that backups (and Supabase's auth audit log, which keeps emails and IP addresses) hold a deleted account for their retention period, and how long that is on your plan.

## Checking it locally

- `supabase/tests/run.sh` runs the migration twice on a throwaway PostgreSQL database (with small stand-ins for Supabase's `auth` and `storage`), with Supabase's default Data API settings and again with the recommended ones, and checks the rules: the Worker's secret key limited to what it uses, chats written only through the functions that keep the limits, deletions that always take effect, account deletion refused while billing or screenshots remain, own rows only, cloud storage needed to save but never to delete, last write wins, quotas counted atomically, the free plan, hand-given plans, subscriptions (active, past due, cancelled, late) and passes (paid, refunded, run out), the most generous plan winning, account deletion cascading.
- `tests/unit/worker.test.ts` checks the Worker: sessions (and junk tokens refused without a call to Supabase), exactly the models it allows, requests rebuilt from text and inline screenshots only and capped in size, Stripe's signature, the webhook mirroring a subscription and a pass (refunds and chargebacks end it; checkouts the Worker didn't make give nothing), checkout and the prices on offer.
- With the Stripe CLI, `stripe listen --forward-to localhost:8787/stripe/webhook` sends test-mode events to `wrangler dev`.
