# ChatPay build checklist

Legend: `[x]` built in this repo · `[ ]` still to do · **(verify)** = written but never run against real infra / never compiled.

How things were checked so far:
- chat-service: 32 automated tests pass, on in-memory storage AND on a real Postgres 16, including real HTTP and Socket.IO.
- chat web (`apps/web`) and storefront (`apps/store-web`): `tsc` and `next build` pass. Neither UI has been clicked through in a browser.
- store-backend (Laravel + Filament): NEVER installed or run as a whole (Composer/Packagist is not reachable from where it was written).
  What was checked: all 77 PHP files pass `php -l`; the JWT/JWKS class and its 4 tests were run for real against the actual `firebase/php-jwt`
  (expired, forged, wrong-issuer and rotated-key cases); `verify.sh` was exercised against a mock server. The other ~45 feature tests
  (`overlay/tests`, run by `php artisan test`) are written but have never executed, and the Filament classes were written against the 4/5 docs.
- wallet-service: migrations V1-V6 were applied to a real Postgres 16 and their rules tested (append-only triggers, four-eyes,
  one live intent per order, settlement constraints). The Java was syntax-checked only: it has NEVER been compiled or run
  (no Maven Central access where it was written). Expect small compile fixes on the first `mvn verify`.

## Done: foundations
- [x] Monorepo: `services/wallet-service`, `services/chat-service`, `services/store-backend`, `apps/web` (chat), `apps/store-web` (storefront), `infra/`
- [x] docker-compose: Keycloak (dev mode + realm import), Postgres for wallet, chat and store, RabbitMQ
- [x] Realm `chatpay`: client `chatpay-web` (PKCE), `laravel-service` (service account), users alice, bob, finance1, finance2
- [x] Wallet: modules `ledger`, `account`, `transfer`, `settlement`, `admin`, `shared`; Flyway V1-V6; outbox + AMQP **(verify)**
- [x] Wallet: `ModularityTests` enforcing module boundaries **(verify)**
- [x] Server-issued transfer intents: create -> review -> confirm, recovery, cancel, expiry + sweeper **(verify)**

## Done: part 1, chat
- [x] Postgres persistence (adapters + migrations) alongside the in-memory adapters; same test suite on both
- [x] Groups: public/private, roles (owner/admin/member), invite many people, accept/decline, join public, leave (ownership handed on)
- [x] Money only in one-to-one chats (UI + chat bubble check)
- [x] Unread counts and @mention counts per room (read cursors), badges in the room list, unread total in the tab title
- [x] @mentions: autocomplete picker, structured mention ids, on-screen toast, optional desktop notification
- [x] Typing indicator wired end to end (sent throttled, shown per room)
- [x] Store icon next to users who have a store (fed by `store.opened` / `store.closed` events)
- [x] Wallet screen in the chat frontend: balance, statement with running balance, filters, load older
- [x] REST `POST /rooms/:id/messages` kept for bots/HTTP-only clients (the web app sends over the socket)

## Done: part 2, wallet
- [x] Ledger statement: `GET /wallet/entries` (cursor paging), `balance_after`, entry `kind` and reference
- [x] Append-only money history enforced by database triggers on `ledger_entry`, `transfer`, `order_escrow`, `settlement`, `admin_audit_log` **(tested on Postgres)**
- [x] Merchant-created intents for orders: `POST /internal/transfer-intents` (role `wallet-merchant`), one live intent per order, price never from the client
- [x] Escrow: order payments go buyer -> `escrow`; per-order hold recorded in the same transaction **(verify)**
- [x] Settlement: `POST /internal/orders/{id}/release` (store minus commission) and `/refund` (back to buyer), idempotent by key **(verify)**
- [x] Store accounts (`STORE` type) separate from owners' personal wallets
- [x] Admin API (role `wallet-admin`): inspect wallet, entries, transfers, reconciliation; request adjustment/reversal; approve/reject **(verify)**
- [x] Four-eyes: the requester cannot approve (service check + database constraint **(tested)**)
- [x] Append-only audit log of every admin write and wallet lookup
- [x] Events: `transfer.completed` now carries `kind`; new `settlement.completed`
- [x] Order payments can no longer be faked as person-to-person: clients may only use reference type `chat`

## Done: store backend, storefront and chat integration
- [x] One Laravel app (API + Filament panels over the same models); API validates Keycloak tokens locally (JWKS) **(verify)**
- [x] Catalog API (public): categories, products with search/category/store filters, hot products, product and store pages **(verify)**
- [x] Checkout: `POST /orders` prices from the store database, reserves stock, asks the wallet for an ORDER payment intent (service account); one order per store **(verify)**
- [x] Payment received -> order paid via `transfer.completed` (only `kind=ORDER_PAYMENT`, intent/payer/amount must match); late payment on a cancelled order is refunded automatically **(verify)**
- [x] Fulfilment: vendor marks shipped/delivered; payout via wallet `release` with commission (scheduled, or "Pay out now"); refund via wallet `refund` **(verify)**
- [x] Transactional outbox + relay: `store.opened`, `store.closed`, `order.paid` to RabbitMQ **(verify)**
- [x] Filament `/admin` (staff): products, categories, stores (activate/suspend), orders, users with wallet lookup, wallet corrections page **(verify)**
- [x] Filament `/vendor` (store owners): own products, own store profile, own orders; scoped in the query, never by trusting the form **(verify)**
- [x] Back office sign-in through Keycloak (authorization code flow, `laravel-admin` client); wallet pages call the wallet with the admin's own token **(verify)**
- [x] Next.js storefront (`apps/store-web`, port 3001): SSR catalog, search, store pages, cart in the browser (anonymous), checkout, payment dialog, my orders with live refresh
- [x] Single sign-on: one realm, client `store-web` (public, PKCE) next to `chatpay-web`
- [x] Chat: "Shop" panel (search, hot products, buy for me / buy for the person in a 1:1 chat), pay dialog, gift-order bubble from `order.paid`; hidden when the store is down
- [x] Realm: roles `vendor`, `catalog-admin`; users admin1 (catalog admin) and bob (vendor, owns the demo store); fixed user ids so seeds match
- [x] Store backend test suite (PHPUnit, in-memory SQLite, fake wallet): catalog visibility, checkout rules, payment events, payout/refund, store events, onboarding, audit, access sync, JWT **(only the JWT tests have been run)**
- [x] `setup.sh` with preflight checks (PHP, extensions, database), Filament 5 -> 4 fallback, runs the tests; `verify.sh` smoke test of a running stack
- [x] Vendor onboarding: apply for a store (`POST /stores`, storefront `/sell`), admin approves in /admin, owner then gets /vendor **(verify)**
- [x] Rate limits on the store API; audit trail of catalog edits (`catalog_audit_log`); dead-letter queue for `store.wallet-events`; Supervisor sample
- [x] Back-office access revocation: roles are re-read from Keycloak whenever the access token expires; a refused refresh signs the person out **(verify)**
- [x] `dev.sh` runs the four store processes (web, events:consume, outbox:relay, schedule:work) in one terminal
- [x] setup.sh fixes found on a real machine: false "missing extension" reports (`pipefail` + `grep -q` race), the skeleton's SQLite `.env` winning over ours, leftover `_skeleton` folder, `.env` is not an INI file
- [x] Rate limits authenticate first and are per signed-in person (an anonymous call can no longer use up the quota); verify.sh now prints the HTTP status it got

## "Next: messaging reliability" (found while mapping the events, see docs/events.md)
- [x] Chat consumers retry transient errors with exponential backoff, then dead-letter; permanent errors dead-letter at once; nothing is discarded (retry queues + `chat.dlx` + `<queue>.dlq`; unit tests, plus a real-broker integration test that runs under `make test-chat` and in CI)
- [x] Store backend consumer: retry with backoff, dead-letter, reconnect by itself (`app/Messaging`; unit tests run standalone, the glue is verified by `scripts/e2e-resilience.sh`)
- [x] Dead-letter tool: `npm run dlq:list` / `dlq:replay` in services/chat-service (works for the store's DLQ too) and `docs/runbooks/dead-letters.md`
- [ ] Alert when any DLQ depth is above zero; alert when `outbox_events` / `event_publication` rows stay unpublished for more than a few minutes
- [x] Wallet: `OutboxSweeper` republishes incomplete events every 30s, not only at restart **(unit-tested; proven end to end only by e2e-resilience.sh broker-outage)**
- [x] Store relay reconnects with backoff and reports how many events are waiting (it no longer exits, so `dev.sh` is enough)
- [ ] Store outbox: per-row failure counters and the last error (needs a migration), shown by `make doctor`
- [x] Failure reason recorded in headers of every dead letter (chat and store)
- [x] Event contracts: shared fixtures in `contracts/events/` with rules (only add fields, bump `version` for breaking changes), tested by the wallet, store, chat and `make check`
- [x] `scripts/e2e-resilience.sh`: chat database outage, poison messages, RabbitMQ outage, each asserting exactly-once delivery **(written; needs a first run on the real stack)**
- [x] chat-service survives database and RabbitMQ outages: pool error listener + timeouts, startup wait for the database, AMQP connection loop that rebuilds on connection OR channel loss, process guards, 503 + Retry-After and `/ready` (alongside `/health`), ack failures no longer mistaken for handler failures (24 tests; `make e2e-resilience` checks the process stays up)
- [ ] Alerting: something that runs `make doctor` on a schedule and tells a person when a dead-letter queue is not empty
- [ ] Correlation ids: one id from the HTTP request through the outbox event to the consumer's log lines

## Next: run it end to end
- [ ] `docker compose up -d` (Keycloak :8080, wallet DB :5433, chat DB :5434, RabbitMQ :5672)
- [ ] `cd services/wallet-service && mvn verify`, fix compile nits, then `mvn spring-boot:run`
- [ ] `cd services/chat-service && cp .env.example .env && npm i && npm run dev` (applies chat migrations)
- [ ] `cd apps/web && cp .env.example .env.local && npm i && npm run dev`
- [ ] `cd services/store-backend && ./setup.sh`, then `php artisan serve --port=8000`, `events:consume`, `outbox:relay`, `schedule:work` (separate terminals)
- [ ] `cd apps/store-web && cp .env.example .env.local && npm i && npm run dev` (port 3001)
- [ ] Two browsers (alice, bob): DM, create a private group with invites, accept, @mention, watch unread badges and typing
- [ ] Alice tops up, pays Bob: bubble for both, both balances change, statement shows the entries
- [ ] Confirm the same intent twice (curl): one payment. Let one expire: 409 `INTENT_EXPIRED`
- [ ] Merchant flow with curl (root README): create order intent as `laravel-service`, confirm as the buyer, release, refund
- [ ] Admin flow with curl: finance1 requests a reversal, finance1 approving it is refused, finance2 approves it, reconciliation is empty
- [ ] Store: sign in to /admin as admin1 and /vendor as bob; edit a product; check that `store.opened` reaches chat (store icon next to bob)
- [ ] Storefront: browse anonymously, add to cart, sign in (no password prompt if already signed in on chat), checkout, confirm payment, see the order become `paid`
- [ ] Chat: open the Shop, buy for yourself, then buy for the person in a 1:1 chat: gift bubble appears for both
- [ ] Order lifecycle: vendor ships and delivers in /vendor, `orders:settle` pays out (store account credited, commission to platform-revenue); refund an escrowed order from /admin
- [ ] Late payment: let an order expire, confirm its payment anyway, check it is refunded automatically
- [ ] Wallet corrections in /admin as finance1 (request) and finance2 (approve); finance1 approving is refused
- [ ] Stop chat-service, pay, restart it: bubble still arrives. Stop RabbitMQ, pay, restart: outbox republishes
- [ ] Try an UPDATE on `ledger_entry` in psql: refused by the trigger

## "Next: containerise everything"
Decision: defer until the stack has run end to end once (see "run it end to end"). Containers around code that has never run just add failure modes.
Node, Next.js and Spring are quick to containerise; Laravel is the part that needs care.
- [ ] Dockerfiles: chat-service, wallet-service (multi-stage Maven build, then a slim JRE image), apps/web and apps/store-web (Next.js `output: "standalone"`)
- [ ] Laravel: one PHP image (php-fpm + required extensions + Composer) built from the skeleton + `overlay/` at BUILD time (no Packagist access needed at run time), plus nginx; the same image run as `web`, `events`, `outbox` and `schedule` services with different commands
- [ ] A compose profile `apps` that runs every service next to the infrastructure (Keycloak, Postgres x3, RabbitMQ); `docker compose up` for the whole system
- [ ] Container networking: service names instead of `localhost`; Keycloak's issuer URL must be the SAME name for browsers and services (the usual trap), e.g. a hosts entry or a fixed `KC_HOSTNAME`
- [ ] Health checks and `depends_on: condition: service_healthy`; migrations as a one-off job
- [ ] Per-service `.env` files and secrets (no secrets baked into images); `.dockerignore` files
- [ ] Until then: `./setup.sh` + `./dev.sh` for the store backend, `npm run dev` for the others

## Next: chat gaps found while building
- [ ] Contacts: today there is only a user directory search. Add explicit contacts or "people I chatted with", plus who-can-find-me privacy
- [ ] Admin tools for groups: remove member, promote/demote admin, rename, delete group, invite links, cancel a pending invite
- [ ] Live update of the store icon (`user:updated` event); today it refreshes on the next load
- [ ] Block / report users, moderation, spam rate limits
- [ ] Attachments, message edit/delete, replies, reactions, message search
- [ ] Offline send queue using the REST endpoint; push notifications (web push / FCM) instead of only desktop notifications
- [ ] Socket.IO Redis adapter for more than one chat instance; cursor "load older" button in the message list
- [ ] Dead-letter queues for the chat's consumers: see messaging reliability (bad messages are currently discarded)

## Next: wallet gaps
- [ ] Testcontainers tests (Postgres + RabbitMQ): double confirm pays once, parallel confirms, expired confirm, insufficient funds then top-up,
      non-owner gets 404, order intent idempotency, release/refund idempotency and `EXCEEDS_HELD`, reversal blocked by insufficient funds
- [ ] Concurrency test: 50 parallel transfers never overdraw and never deadlock
- [ ] Refund AFTER a release (must pull money back from the store account); partial refunds policy; disputes/chargebacks
- [ ] Approval threshold: small adjustments auto-approved, large need a second admin; configurable limits per role
- [ ] Audit admin reads other than wallet lookup; export of the audit log; alerting on reconciliation mismatches (scheduled job)
- [ ] Step-up auth (PIN) on `confirm`; limits / fraud checks at create and confirm; fee quotes; recipient display name on the review step
- [ ] Order payment dialog in the chat/store frontends (review + confirm for an existing intent id; today's dialog is person-to-person)
- [ ] Statement: counterparty names, CSV export, receipts; per-order view
- [ ] Database role for the app with no UPDATE/DELETE privileges on append-only tables (belt and braces on top of the triggers)
- [ ] Remove the `dev` profile and `/dev/topup` outside local development; secrets out of `application.yml`

## Next: store backend gaps
- [ ] FIRST: run `./setup.sh` on a machine with Composer access, then `./verify.sh`; fix whatever the first install, the test run and the panel load reveal
- [ ] Order payment of a cart with several stores in one go (today one order and one payment per store): needs a parent "checkout" that groups orders and one wallet payment that fans out into several escrow holds
- [ ] Vendor earnings view: needs a wallet endpoint that lets a store owner read their store account (today only finance can)
- [ ] Refund AFTER payout (pull money back from the store account), partial refunds, returns workflow, disputes
- [ ] Shipping and fees: collect an address at checkout (stored by the API, not collected by the storefront yet), delivery options, tax
- [ ] Catalog features: variants, multiple images, reviews and ratings, coupons, wishlists
- [ ] Notifications to buyers and vendors (email/SMS/push) on order status changes; tell an applicant when their store is approved
- [ ] Search engine (Meilisearch / Typesense / Elasticsearch) instead of SQL `like`; image resizing + CDN
- [ ] Vendor staff accounts (more than the owner); read-only audit log screen in /admin (the table is written but has no UI)
- [ ] Replay tooling for `store.wallet-events.dlq` (see messaging reliability)
- [ ] Stricter rate limiting per user (today per IP), and a WAF/edge limit in front of the API

## Next: storefront and integration gaps
- [ ] Extract shared packages for the two Next.js apps (`core/http`, `auth`, `money`, wallet client, `PayOrderDialog`, UI kit) instead of copies
- [ ] Shipping address and phone at checkout; order detail page; the order list is basic
- [ ] Wishlist, saved addresses, order tracking; SEO metadata, sitemap, product structured data; image optimisation (`next/image`)
- [ ] Chat: order bubble for self-purchases is intentionally not shown; add "my purchases" link, show order status updates in the chat
- [ ] Chat: a "share this product" message (product card in a conversation) and group chats can not receive gifts yet
- [ ] Logging out of one app does not log out the other (Keycloak SSO session): decide whether single logout is wanted
- [ ] Feature flags so the Shop panel in chat and the chat link in the store can be switched off by configuration

## Later: identity, security, operations
- [ ] Keycloak for real use: own database, HTTPS, hostname, proper admin password, backups; add `aud` mappers and validate them
- [ ] Remove `directAccessGrantsEnabled` and the dev secret once you stop curling for tokens; decide token storage (browser vs BFF cookies)
- [ ] Per-service broker credentials and permissions (only the wallet may publish to `wallet.events`)
- [ ] Rate limiting and security headers on all APIs; data protection obligations (retention, deletion, export)
- [ ] Dockerfiles + compose for all apps, CI (wallet `mvn verify`, chat `npm test`, web `next build`), environments, backups and a restore drill
- [ ] Correlation ids across HTTP and events, structured logs, metrics and tracing
- [ ] Event schema contract tests (wallet/store publish, chat/Laravel consume); shared `packages/contracts`

## Later: real money
- [ ] Legal/regulatory review for holding or moving customer funds in your market; licensed partner if required
- [ ] KYC tiers and limits (stricter for vendors); payout schedules and commission configuration
- [ ] `funding` module with a `PaymentProvider` port: fake provider first, then the MTN MoMo sandbox, then a real provider
- [ ] Intent state `PROCESSING`, webhook handling with duplicate protection, status polling fallback, reconciliation against statements
- [ ] Currency decision beyond GMD

## Later: ports
- [ ] NestJS: wrap `ChatService` as a provider, `src/http` -> controllers, `src/ws` -> `@WebSocketGateway`
- [ ] React Native: extract `src/core` + `src/hooks` into `packages/client-core`; replace `core/auth.ts`; rewrite `src/ui`
