# Deploying VoltCore on Railway

## Where the deploy settings live

| Setting | Where it is set | Value |
|---|---|---|
| Build | `Dockerfile` (repo) | `npm ci`, `npx prisma generate`, `CMD ["npm", "start"]` |
| Start command | `Dockerfile` `CMD` (also `startCommand` in `railway.toml`) | `npm start` → `node src/index.js` |
| **Pre-deploy command** | **Railway dashboard only**: app service → Settings → Deploy → Pre-deploy command | `npx prisma db push --skip-generate` |

Railway ignored `preDeployCommand` in `railway.toml` (the deploy of 2026-11-27/28 ran no
pre-deploy step until it was entered in the dashboard). Because of that, `railway.toml` no
longer contains it: one place only, so the two cannot disagree. Do not assume other
`railway.toml` settings are applied either; `startCommand` matches the Dockerfile `CMD`, so it
makes no difference.

Why the file was ignored has not been checked yet (see `docs/day24-prep.md`).

## Rules for the pre-deploy command

- Never add `--accept-data-loss`. Without it, Prisma stops when a change could lose data, the
  deploy fails, and the previous deployment keeps running.
- `db push` is not atomic. If the log shows anything other than "now in sync" or "already in
  sync", stop and explain the exact database state before trying anything else.
- It stays `db push` only until a Prisma Migrate baseline replaces it with
  `npx prisma migrate deploy` (see `docs/day24-prep.md`). That change is made in the dashboard.

## Deploying

1. Back up the database (Railway → Postgres → Backups → Create backup), and record row counts
   for `User`, `Job`, `CreditWallet` and a few wallet balances.
2. Merge `audit/stabilise` into `main` with a fast-forward (the founder does this).
3. In Railway, deploy the latest `main` commit. Do not use "Redeploy" on an older deployment:
   it rebuilds that deployment's old commit.
4. Check the deployment card shows the expected commit, then read the Build Log and the Deploy
   Log. The pre-deploy section must say "in sync" before the app start lines.
5. Verify row counts and balances, then `/start`, `/balance`, `/transactions` in Telegram.
