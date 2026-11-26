# Day 24 prep list

Carried over from the Day 23 stabilisation audit. Top item first.

## 1. DEBT (top): restore unique `User.email` and `User.referralCode` before any real customer signup

Both are plain indexes, not unique, since commit `22515ed`. Adding a unique constraint to an
existing table makes `prisma db push` stop with a data-loss warning, which blocked every deploy.
Until this is fixed, the database itself does not stop two accounts sharing an email or a
referral code. The app checks email on registration, but two simultaneous sign-ups can still
slip through.

Before the first real customer signs up (web signup, referral codes):

1. Check production for duplicates (read-only):
   ```sql
   SELECT 'email' AS field, email AS value, count(*) FROM "User" WHERE email IS NOT NULL GROUP BY email HAVING count(*) > 1
   UNION ALL
   SELECT 'referralCode', "referralCode", count(*) FROM "User" WHERE "referralCode" IS NOT NULL GROUP BY "referralCode" HAVING count(*) > 1;
   ```
2. Resolve any duplicates with the founder (never by deleting users).
3. Add `@unique` back as a reviewed Prisma Migrate migration (see item 2), not through `db push`.

`User.telegramId` was checked: it is still unique (index `User_telegramId_key`), now nullable.

## 2. Baseline a Prisma Migrate workflow and retire `db push`

`preDeployCommand = "npx prisma db push --skip-generate"` stays only until this is done.

1. Once production matches `schema.prisma`, create the baseline migration
   (`prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script`)
   in `prisma/migrations/0_init/migration.sql`.
2. Mark it as applied in production: `prisma migrate resolve --applied 0_init`. This needs a
   founder-approved step, because it writes the `_prisma_migrations` table.
3. Switch the pre-deploy step to `npx prisma migrate deploy`.
4. Every later schema change is a migration file reviewed as SQL in a PR.
5. Make `npm run smoke` fail when the database and the schema differ.

## 3. Known risk of the current pre-deploy step

`db push` is not atomic. A failure part-way (connection drop, lock timeout) leaves a partial
schema, and a re-run can then stop on new warnings. If the Deploy Log shows anything other than
"in sync", stop and describe the exact state before considering any flag.
