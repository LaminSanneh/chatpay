# Checklist additions (this round)

Paste these into CHECKLIST.md.

## Under "Done: store backend, storefront and chat integration"
- [x] `dev.sh` runs the four store processes (web, events:consume, outbox:relay, schedule:work) in one terminal
- [x] setup.sh fixes found on a real machine: false "missing extension" reports (`pipefail` + `grep -q` race), the skeleton's SQLite `.env` winning over ours, leftover `_skeleton` folder, `.env` is not an INI file
- [x] Rate limits authenticate first and are per signed-in person (an anonymous call can no longer use up the quota); verify.sh now prints the HTTP status it got

## New section: "Next: messaging reliability" (found while mapping the events, see docs/events.md)
- [ ] Chat consumers (`chat.wallet-events`, `chat.store-events`) currently DISCARD a message that fails (nack without requeue, no dead-letter exchange). Add DLQs, and retry transient errors (e.g. Postgres briefly down) before dead-lettering
- [ ] Retry queues with delays (10 s, 30 s, 5 min) then DLQ, for chat and store consumers; or quorum queues with `x-delivery-limit`
- [ ] A way to look at and replay dead letters: a replay script/command per service (or RabbitMQ Shovel "move messages"); document the runbook
- [ ] Alert when any DLQ depth is above zero; alert when `outbox_events` / `event_publication` rows stay unpublished for more than a few minutes
- [ ] Wallet: republish incomplete events periodically (Modulith `IncompleteEventPublications`), not only at restart
- [ ] Store relay: count failed attempts, back off, and exit non-zero so a supervisor restarts it; `dev.sh` does not restart crashed processes
- [ ] Record the failure reason with each dead letter (headers) so triage does not need the logs
- [ ] Schema versioning rules for events (`version` field exists): consumers ignore unknown fields, new fields only added

## New section: "Next: containerise everything"
Decision: defer until the stack has run end to end once (see "run it end to end"). Containers around code that has never run just add failure modes.
Node, Next.js and Spring are quick to containerise; Laravel is the part that needs care.
- [ ] Dockerfiles: chat-service, wallet-service (multi-stage Maven build, then a slim JRE image), apps/web and apps/store-web (Next.js `output: "standalone"`)
- [ ] Laravel: one PHP image (php-fpm + required extensions + Composer) built from the skeleton + `overlay/` at BUILD time (no Packagist access needed at run time), plus nginx; the same image run as `web`, `events`, `outbox` and `schedule` services with different commands
- [ ] A compose profile `apps` that runs every service next to the infrastructure (Keycloak, Postgres x3, RabbitMQ); `docker compose up` for the whole system
- [ ] Container networking: service names instead of `localhost`; Keycloak's issuer URL must be the SAME name for browsers and services (the usual trap), e.g. a hosts entry or a fixed `KC_HOSTNAME`
- [ ] Health checks and `depends_on: condition: service_healthy`; migrations as a one-off job
- [ ] Per-service `.env` files and secrets (no secrets baked into images); `.dockerignore` files
- [ ] Until then: `./setup.sh` + `./dev.sh` for the store backend, `npm run dev` for the others

## Replace these two lines in "Next: chat gaps" and "Next: store backend gaps"
- Chat gaps: "Dead-letter queue for `chat.wallet-events` and `chat.store-events`" -> "Dead-letter queues for the chat's consumers: see messaging reliability (bad messages are currently discarded)"
- Store gaps: "Dead-letter handling: a way to inspect and replay ..." -> "Replay tooling for `store.wallet-events.dlq` (see messaging reliability)"
