# Where Menu's secrets live

**No secret values belong in this file — only where each one lives and how to
get it back.** The values live in `.env.local` (gitignored), which opens with a
"do not delete any line" header for the same reason this file exists.

Written after `.env.local` was rebuilt with only the four Supabase keys, which
silently dropped the webhook secret and both halves of the push key. Two were
recoverable; the push private key was not, and had to be rotated. If you ever
rebuild this file, **enumerate the keys from every consumer below** rather than
restoring the obvious set.

## The keys

| Key | Used by | Canonical copy | If it's lost |
|---|---|---|---|
| `SUPABASE_URL` | everything; also public in `js/config.js` | Supabase dashboard → Project Settings → API | copy it again, harmless |
| `SUPABASE_ANON_KEY` | guest menu; also public in `js/config.js` | same | copy it again, harmless |
| `SUPABASE_SERVICE_ROLE_KEY` | **the weekly backup script**, admin scripts | same | copy it again. ⚠️ While missing, backups skip the Menu database **without failing** |
| `SUPABASE_ACCESS_TOKEN` | DDL + Edge Function deploys | Lexi's Supabase account → Account → Access Tokens | **cannot be read back** — Lexi generates a new one |
| `ORDER_WEBHOOK_SECRET` | `order-sms`, `order-push`, `request-escalate`; the DB trigger sends it | `.env.local` + Supabase function secrets | recoverable: it's embedded in `notify_order_sms`'s source (`select prosrc from pg_proc where proname='notify_order_sms'`) |
| `VAPID_PUBLIC_KEY` | staff push subscribe | `.env.local`, function secrets, **and `js/config.js`** | recover from `js/config.js` |
| `VAPID_PRIVATE_KEY` | `order-push`, `request-escalate` sign with it | `.env.local` **only** — Supabase stores it write-only | ❗**not recoverable.** Generate a new pair, set both function secrets, update `js/config.js`. Existing subscriptions die; the dashboard re-issues them silently when each staff member next opens it |
| `MENU_DB_PASSWORD` | direct Postgres connections only — nothing in the app | Supabase dashboard | Lexi resets it; nothing else breaks |

## Consumers to check when rebuilding `.env.local`

- `scripts/backup-db.mjs` **in the Finance repo** — reads `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` *from this repo's `.env.local`* to back up the
  Menu database. Easy to forget: the script lives in another folder.
- Edge Functions `order-sms`, `order-push`, `request-escalate` — their secrets
  are set on Supabase, not read from this file, but the file is where we keep
  the copy we'd need to set them again.
- `js/config.js` — carries the public URL, anon key and VAPID public key by
  design. Never put a private key here.

## Backups of the file itself

- `~/Documents/tanawin-backups/secrets/` — with restore instructions
- `~/Documents/Tanawin-USB-Backup/1-SECRETS/` — rebuilt weekly, meant to be
  copied to a USB drive

Refresh both after changing any key.
