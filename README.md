# Moaney

Self-hosted, single-user personal finance app. Spec: [PERSONAL_FINANCE_SPEC.md](PERSONAL_FINANCE_SPEC.md).
This repo currently implements **M0 (foundation) and M1 (ledger and manual capture)**. No notification ingest, LLM, or MCP yet.

One Node 22 + TypeScript Express process serves the REST API and the Vite + React PWA, backed by SQLite (WAL) through Drizzle.

## Local development

```bash
npm install
cp .env.example .env            # set NODE_ENV=development, BEHIND_TLS=false
npm run hash-password -- "choose a password of 10+ chars"   # paste output into OWNER_PASSWORD_HASH
npm run build                   # builds dist/ (server) and dist/web (PWA)
npm start                       # http://127.0.0.1:8790
```

Hot reload: `npm run dev` (API) and `npm run dev:web` (Vite, proxies `/api`). Checks: `npm test`, `npm run lint`, `npm run typecheck`.

The first start creates `data/moaney.db`, runs migrations and seeds your categories and wallets (BCA, Jago, GoPay, Cash, Owed to me, Before Moaney) only if the database is empty.

## What is in M0 + M1

- Owner login (scrypt hash, HttpOnly session cookie, CSRF header, login rate limit), strict CSP and security headers.
- Wallets and categories, transactions (expense, income, transfer), balanced journal lines regenerated on every edit, void with audit trail.
- Money is integer minor units, IDR exponent 2, no floats (`shared/money.ts`).
- Typed entry: `kopi 28k gopay`, several items with "dan" / "and", `gaji 8jt bca`, `transfer bca ke gopay 500k`.
- Home (today, month vs same point last month, Log again chips), History, Wallets, Add.
- `transactions.csv` import with template, preview, duplicate detection and the history-only "Before Moaney" wallet; CSV export.
- Daily SQLite backup (`VACUUM INTO`) after 03:00 Jakarta, rotated (`BACKUP_KEEP`).
- Installable PWA shell (service worker caches the app shell only; `/api` is never cached).

Deviation from the spec text: amounts are JS `number` (safe-integer checked) rather than `bigint`; Rp9 quadrillion is far beyond any personal balance.

## Deploy to the VPS (not yet done)

Follow the `oracle-xclaw` rules: read `docs/operations/vps.md` first, take a backup, preserve other workloads.

1. Pick a free loopback port and set it in `.env` and `deploy/nginx-moaney.conf`.
2. Cloudflare: DNS-only `A` record `moaney` to the VPS.
3. On the VPS: clone the repo to `~/moaney`, `npm ci`, `npm run build`, create `.env` (mode 0600, `BEHIND_TLS=true`, `NODE_ENV=production`) and `data/`, `~/backups/moaney/`.
4. Install `deploy/moaney.service` to `/etc/systemd/system/`, `systemctl enable --now moaney`.
5. Install the nginx block, `nginx -t`, reload, then `certbot --nginx -d moaney.arfani.my.id`.
6. Verify: `curl https://moaney.arfani.my.id/health`, sign in on the phone, install the PWA, confirm a file appears in `~/backups/moaney/` and restores (`sqlite3 file "select count(*) from wallets"`).
7. Updates: push, then on the VPS `git pull --ff-only && npm ci && npm run build && systemctl restart moaney`.
8. Record lessons in `oracle-xclaw/docs/operations/moaney.md`.

## CSV format

`date,type,amount,wallet,to_wallet,category,description,note,external_id` (UTF-8, comma separated). Download the template from the Import screen. Blank wallet means "Before Moaney". Re-importing the same file adds nothing.
