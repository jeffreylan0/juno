# Juno privacy policy

*Effective [date of publishing]*

Juno is a study app for macOS and Windows, made by humanbn ("we", "us"). This policy says what Juno does with your information, in plain words. Questions: info@humanbn.com.

## The short version

- What you select, ask and get back stays on your computer, unless you ask a question (it goes to the AI you chose) or turn on cloud sync.
- Your own API key stays on your computer and is sent only to the company that issued it.
- An account is optional. It holds your email address, your plan, how many hosted answers you used this month and, if you turn it on, a copy of your saved chats.
- No ads, no analytics, no tracking. We don't sell your information, and nothing you send is used to train AI models.

## What stays on your computer

These live in Juno's data folder on your computer, and we can't see them:

- **Chats**: what you selected (a screenshot of that area of the screen), what you asked, and the answers. You choose how many saved chats are kept (1 to 100). Temporary chats are kept in memory only and deleted, with their screenshots, when you finish them. *Settings → Chats & privacy → Delete all chats* deletes them.
- **Settings**, and a count of this month's answers (shown at the top of Settings).
- **The unlock's license**, if you bought it: a signed note that this computer is unlocked.
- **Your API keys**, in a file only your user account can read (encrypted with Windows' own data protection on Windows). Juno's windows can't read them back; only the part of the app that sends your question to Anthropic or OpenAI uses them.

Juno looks at your screen only when you select something. On macOS it needs Screen Recording for that, and nothing else; on Windows, no permission at all.

## What leaves your computer, and when

**When you ask a question**, your selection, your question and the chat so far go to whoever answers, as you chose in Settings:

| Who answers | Where it goes | What they keep |
| --- | --- | --- |
| Your own key | Straight to Anthropic or OpenAI, under your own agreement with them | Anthropic deletes API inputs and outputs within 30 days (longer only if flagged for a usage-policy review). OpenAI keeps abuse-monitoring logs for up to 30 days; Juno asks it not to store anything else. Neither trains on API traffic by default (OpenAI does if your key's organization opted in to sharing). |
| A local model | Only the model on your computer (or the address you gave it) | Nothing reaches us or any AI company |
| Hosted answers (with an account) | Our server on Cloudflare, which passes it to Anthropic or OpenAI with our key | The same as above. Our server keeps no copy of what you asked or the answer, and caches no answer; it counts one answer against your plan |

**If you make an account** (optional):

- **Email codes**: your email address, to send you a sign-in code through our email provider ([email provider]).
- **Google sign-in**: Google tells us your email address, your name and profile picture, and an account ID. Juno asks Google for nothing else; your name and picture are shown only to you, in Settings.
- **Your account** is kept by Supabase, our database provider ([region]): your email address, when you signed up and last signed in, your plan, how many hosted answers you used each month, and when you paid. For security, Supabase also keeps a log of sign-ins, with your email and IP address.
- **Cloud sync** (on plans that include it, off until you turn it on): a copy of your saved chats and their screenshots, in a private storage space only your account can read. Temporary chats are never copied.

**If you buy a plan**, Stripe handles the payment. We never see your card number. We keep your Stripe customer ID, what you bought, and when it renews or ends; Stripe keeps its own payment records, as the law requires.

**If you buy the unlock** without an account, Stripe handles the payment too. Juno sends an identifier of your computer with it: a one-way hash of the identifier your operating system gives it, from which the identifier itself can't be recovered, and which means nothing outside Juno. It is kept with the payment in Stripe, so the unlock holds on that computer only and can be restored there after a reinstall. Our server keeps nothing about you for it.

**Updates**: if *Update automatically* is on (Settings → Juno), the app checks GitHub for a new version from time to time. GitHub sees your IP address and the request, as for any download.

## Who processes your information for us

| Company | What for |
| --- | --- |
| Supabase | Accounts, plans, cloud sync |
| Cloudflare | Our server for hosted answers and payments |
| Anthropic, OpenAI | Answers (hosted answers, or your own key under your agreement with them) |
| Stripe | Payments, receipts, tax |
| Google | Sign-in with Google, if you use it |
| [email provider] | Sign-in codes by email |
| GitHub | Downloads and updates |

Each processes your information only to provide its part of Juno. They are in the United States, so your information may be processed there.

## How long we keep it

- **On your computer**: until you delete it, or uninstall Juno and remove its data folder.
- **Your account and cloud copy**: until you delete your account. Deleting a chat in Juno deletes its cloud copy too.
- **Deleting your account** (Settings → Account → *Delete account*) deletes your account, your cloud copy, your screenshots and your usage at once, and closes your Stripe customer record. Copies in our database backups are deleted when those backups expire ([backup retention] days), and the sign-in log keeps its entries for [audit log retention] days. Stripe keeps payment records for as long as the law requires.

## Your choices and rights

You can use Juno without an account, with your own key or a local model. You can see what your account holds in Settings, turn cloud sync off, delete any chat, and delete your account at any time.

Depending on where you live (for example in the EU, the UK or California), you have the right to access, correct, delete or take a copy of your personal information, and to object to how we use it. Write to info@humanbn.com and we will answer within 30 days. We use your information to provide Juno to you (our contract with you), to keep it secure and working (our legitimate interest), and to meet legal obligations such as tax records. You may also complain to your local data protection authority.

We do not sell or share your personal information for advertising, as California law defines those terms.

## Children

Juno is not for children under 13, and we do not knowingly collect information from them. If you are a parent and believe your child under 13 made an account, write to info@humanbn.com and we will delete it. Schools that want to use Juno with students should contact us first.

## Security

API keys never leave your computer except to the company that issued them. Your account's data can be read only by you, and by our server for what it does for you (counting hosted answers, recording payments); connections are encrypted; and the secrets the app must not hold stay on our server. No system is perfectly secure; if something goes wrong that affects your information, we will tell you.

## Changes

If we change this policy, we will update the date above, and email account holders before a change that matters takes effect.

## Contact

humanbn, [postal address], info@humanbn.com
