# VoltCore: Agent Guide (persistent)

Read this at the start of every session. It is short on purpose. The task for a given session comes from the founder's message, not from this file.

## Mission and identity (locked)

VoltCore exists to build humanity's most comprehensive knowledge infrastructure and transform that knowledge into discoveries that expand understanding, improve reality, advance civilization, empower the next generation of entrepreneurs, and establish African leadership in the age of intelligence.

VoltCore is a Knowledge Discovery Institution that uses AI as an instrument. It is not an AI company, a model company, or a cloud company. Today's business is a pure GPU reseller for Africa (WhatsApp/Telegram, Naira, Paystack), and that business is the first living laboratory.

Doctrines you must not violate:

1. **Reality Before Intelligence**: every deployed system is a living laboratory. Reality is the final authority. Benchmarks guide, reality decides.
2. **Institution Before Technology**: no technology defines VoltCore. Prefer loose coupling and provider-agnostic code so any instrument can be replaced.
3. **Workload-Aware Compute**: VoltCore sells distinct compute products, not interchangeable GPU hours.
4. **Sacred Knowledge Framework** (PUBLIC / ATTRIBUTED / PROTECTED): PROTECTED knowledge is never used for training.
5. **Interaction Doctrine**: interactions must be clear, cultural, contextual, and transparent. Error messages are interactions.

## Hard constraints (if a task conflicts, stop and escalate)

- Pure reseller. Never own or operate physical GPUs.
- Pre-pay only. Never extend credit.
- Cheapest-first routing with at least 25% gross margin.
- Africa-first customers in Phase 1.
- No web console before MVP is live.
- Explicit consent before any user data enters a training pipeline.
- Zero Trust: never print or commit secrets, tokens, SSH credentials, or raw user message content.
- Tier 1 (compute) must prove paying demand before Tier 2 is resourced.

## Stack and conventions

- Node.js, ESM (`"type": "module"`). Every relative import ends in `.js`.
- All filenames lowercase. Windows hides casing bugs that break on Linux.
- PostgreSQL + Prisma. Redis + BullMQ. Telegraf (Telegram). Baileys is a temporary WhatsApp bridge on a dedicated number; the Meta Cloud API migration comes later. Hosting is Railway.
- Every ioredis/BullMQ connection uses `family: 0`, and BullMQ connections also set `maxRetriesPerRequest: null`. Build connections in one shared factory, not per file.
- Providers sit behind one interface (RunPod, Vast.ai, TensorDock). Never hardcode provider logic in handlers.
- Reseller sells pods (not serverless). The default image is an env config value (`RUNPOD_DEFAULT_IMAGE`), never hardcoded.

## Money-path rules (strictest area of the codebase)

- Wallet changes happen only inside a database transaction.
- Every credit and debit is idempotent (Paystack reference, job id + status guard) and writes an audit row.
- Balance is held or deducted when a job is created, and refunded only if that hold exists.
- A refund happens once per job. Guard with a status condition (`updateMany` with a status filter, check the count), not read-then-write.
- Terminate the provider pod before refunding, or you pay for compute you refunded.
- Deploy a pod once, then poll the same pod id. Never redeploy because ports are not ready yet.
- Never show raw provider errors to users. Log the detail, show a plain reason.
- Notifications use platform ids (Telegram chat id, WhatsApp number), never the internal database user id.

## How you work

- Explain why, not only how. The founder is learning, so every fix is a teaching moment.
- Read the actual log or error before proposing a fix. Fix root causes, not symptoms.
- Work on a branch, never directly on `main`. One commit per fix category, pushed immediately.
- Commit message format: `[CLASS] area: what and why`, where CLASS is BLOCKER, CRITICAL, DEBT, or STRATEGIC.
- Before deleting any symbol or file, `grep -rn` for its usage.
- Do not add features during stabilisation work.
- Never claim a deploy succeeded without log evidence. Use `railway logs` if the CLI is installed and linked. Otherwise ask the founder to paste the Build Log, then the Deploy Log.
- Print environment variable names only, never values.

## Ask the founder before

- Running anything destructive against a database (`db push --accept-data-loss`, `migrate reset`, deletes). Take a `pg_dump` first and confirm which database it targets.
- Force-pushing, rewriting history, or rotating or revoking secrets.
- Changing wallet, pricing, or margin logic beyond a requested fix.
- Anything that conflicts with a doctrine or hard constraint above.
- Architectural changes (for example Telegram polling to webhooks).

## Out of scope unless the founder says otherwise

WhatsApp Cloud API migration, web dashboard, new features, model training.
