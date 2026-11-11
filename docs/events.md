# Events, queues and background workers

Everything RabbitMQ carries, who publishes it, who listens, and what each long-running process does.
(Browsers never talk to RabbitMQ: they use HTTP and, for chat, Socket.IO.)

## RabbitMQ

| Exchange (topic, durable) | Routing key | Published by | Listened to by (queue) | What the listener does |
|---|---|---|---|---|
| `wallet.events` | `transfer.completed` | wallet-service | chat-service (`chat.wallet-events`) | kind `P2P` with reference `chat` -> payment bubble in that 1:1 room; anything else ignored |
| | | | store-backend (`store.wallet-events`) | kind `ORDER_PAYMENT` with reference `order` -> order becomes `paid` (if intent, buyer, amount and currency match) |
| `wallet.events` | `settlement.completed` | wallet-service | store-backend (`store.wallet-events`) | keeps the order's final state in sync (RELEASE -> completed, REFUND -> refunded) |
| `store.events` | `store.opened`, `store.closed` | store-backend | chat-service (`chat.store-events`) | sets or clears the store icon on the owner's profile |
| `store.events` | `order.paid` | store-backend | chat-service (`chat.store-events`) | gift bubble in the 1:1 chat the order came from (only when bought for the other person) |
| `store.dlx` (fanout) | (dead letters) | RabbitMQ, when store-backend rejects a message | queue `store.wallet-events.dlq` | nothing: it waits for a human |

Both consumers of `transfer.completed` get their own copy (separate queues) and filter by `kind`/reference.
The wallet consumes nothing from RabbitMQ.

## How events get onto the exchange (the outbox pattern)
- **wallet-service:** `TransferCompleted` / `SettlementCompleted` are written to the `event_publication` table in the SAME database transaction as the money
  movement (Spring Modulith). After commit, Modulith publishes them (`@Externalized`) and marks them done. If RabbitMQ is down they stay unpublished and are
  republished when the wallet restarts (`spring.modulith.republish-outstanding-events-on-restart`) AND by a timer (`OutboxSweeper`, every `wallet.event-republish-interval-ms` = 30s, for events waiting longer than `wallet.event-republish-min-age-seconds` = 30s), so a broker outage heals without a restart.
- **store-backend:** `StoreObserver` and `OrderService` call `EventPublisher::publish()`, which inserts a row into `outbox_events` (model `OutboxEvent`) inside
  the same transaction as the change. `php artisan outbox:relay` (a loop, every second) publishes pending rows with publisher confirms and then sets `published_at`. If RabbitMQ is unreachable it logs how many events are waiting and reconnects with backoff (1s, 2s, 4s ... 30s) instead of exiting.
  `OutboxEvent` is only touched in two places: `EventPublisher` (write) and `RelayOutbox` (read + mark), so no other code mentions it.
- Delivery is at-least-once, so every consumer is idempotent: chat has unique indexes on the transfer id and the order id; the store checks the order's status.

## Other links (not RabbitMQ)
| From | To | How | For |
|---|---|---|---|
| chat web, store web | wallet-service | HTTP, the user's own token | balance, statement, create/confirm/cancel payment intents |
| chat web, store web | store-backend | HTTP (public catalog; token for orders) | products, checkout, orders, apply for a store |
| chat web | chat-service | HTTP + Socket.IO | rooms, history; live `message:new`, `mention`, `room:new`, `room:updated`, `room:read`, `invite:new`, `typing` (server -> browser) and `message:send`, `typing`, `room:read` (browser -> server) |
| store-backend | wallet-service | HTTP, service account (client credentials, role `wallet-merchant`) | create order payment, release, refund |
| Filament back office | wallet-service | HTTP, the signed-in admin's own token (role `wallet-admin`) | inspect wallets, request/approve corrections |
| every service | Keycloak | JWKS (public keys, cached) | validate tokens locally |
| store web | store-backend | polling every 4 s | order status after paying (the payment event arrives a moment later) |

## What runs where
| Service | Process | What it does |
|---|---|---|
| wallet-service | the Spring app | API; Modulith publishes outbox events after commit; `@Scheduled` `expireStale` every 60 s (marks old payment intents EXPIRED) |
| chat-service | one Node process | HTTP + Socket.IO; in-process consumers of `chat.wallet-events` and `chat.store-events` (reconnect loop every 5 s) |
| store-backend | `php artisan serve` (php-fpm in production) | the API and the back office |
| | `events:consume` | consumes `store.wallet-events` |
| | `outbox:relay` | publishes `outbox_events` to `store.events` |
| | `schedule:work` | `orders:expire` every minute (cancel unpaid orders, put stock back); `orders:settle` every 5 minutes (release escrow for delivered orders through the wallet API) |

`./dev.sh` runs the four store processes in one terminal. It does NOT restart a process that crashes; Supervisor (`overlay/deploy/supervisor/store-backend.conf`) does.

## When processing fails
| Where | Failure | What happens today |
|---|---|---|
| store-backend consumer | exception while handling a message | same policy as the chat: transient (database or wallet trouble, unknown errors) retried with backoff 2s, 4s, 8s, 16s, 30s via `store.wallet-events.retry.<delay>ms`, then dead-lettered; permanent (bad JSON, wrong types, data the database refuses) dead-lettered at once. Dead letters: `store.dlx` -> `store.wallet-events.dlq`, with the error in headers. Replay with the dead-letter tool (docs/runbooks/dead-letters.md). |
| store-backend consumer | a payment that does not match the order, or arrives for a cancelled order | NOT a failure: order -> `payment_review`, or an automatic refund. Nothing goes to the DLQ. |
| chat-service consumers | exception while handling a message | transient (database or network trouble, unknown errors): retried with exponential backoff (2s, 4s, 8s, 16s, 30s), then dead-lettered. Permanent (bad JSON, failed validation): dead-lettered at once. Dead letters wait in `<queue>.dlq` with the error in headers. If the copy cannot be stored, the message goes back to its queue: nothing is dropped. |
| wallet-service | RabbitMQ down when publishing | event stays in `event_publication`; republished by the timer (and at restart) |
| store-backend relay | RabbitMQ down | rows stay unpublished; the relay reconnects with backoff and sends them when the broker is back |
| any consumer | down for a while | the durable queue keeps the messages until it is back |

## Retry and dead-letter topology (chat-service)
    <exchange> --routing keys--> chat.<x>-events --transient error--> chat.<x>-events.retry.<delay>ms   (one per backoff step, TTL = delay)
                                      ^                                          |
                                      +---------- TTL expires: back to the main queue
    chat.<x>-events --permanent error, or retries used up--> chat.dlx --> chat.<x>-events.dlq   (waits for a person)
- Code: `services/chat-service/src/messaging/` (`topology.ts`, `retry-policy.ts`, `consumer-runner.ts`). Policy: `RETRY_INITIAL_MS`, `RETRY_MULTIPLIER`, `RETRY_MAX_MS`, `RETRY_MAX_ATTEMPTS` (defaults 2000, 2, 30000, 5 retries).
- The main queues also carry `x-dead-letter-exchange` / `x-dead-letter-routing-key`, so a bare reject at the broker level lands in the DLQ too.
- A retried message returns through the default exchange; its original routing key travels in `x-original-routing-key`. Retries can reorder events: consumers are idempotent.
- Headers on a dead letter: `x-failure-kind`, `x-error-class`, `x-error`, `x-error-stack`, `x-original-queue`, `x-original-routing-key`, `x-retry-count`, `x-first-failed-at`, `x-failed-at`.
- Queues created before this change must be deleted once (RabbitMQ will not redeclare a queue with different arguments): `./scripts/reset-chat-queues.sh --yes`. `make doctor` flags a queue without a dead-letter exchange.

The store backend's consumer follows the same pattern for `store.wallet-events` (retry queues `store.wallet-events.retry.<delay>ms`, dead letters via `store.dlx` to `store.wallet-events.dlq`; its main queue keeps its original arguments). Both services write the same failure headers, so one tool lists and replays either: `docs/runbooks/dead-letters.md`. Both consumers also reconnect to RabbitMQ by themselves.

Shape of every event: `contracts/events/` (shared fixtures that each producer and consumer tests against).

## Dead-letter queues: how to think about them
A dead-letter queue is a quarantine, not a retry mechanism. Messages land there when a consumer rejects them, expires them, or a queue overflows.
1. **Sort failures into two kinds.** Transient (database or network briefly down): retry, after a delay, a limited number of times. Permanent (malformed payload,
   unknown schema version, a bug): dead-letter at once, because retrying cannot help.
2. **Retry with a delay, not a tight loop.** Typical: a retry queue with a TTL whose dead-letter target is the main exchange, so a message comes back after, say, 10 s,
   30 s, 5 min; after N attempts it goes to the DLQ. Quorum queues also offer a delivery limit that dead-letters poison messages automatically.
3. **Monitor the DLQ.** Alert when its depth is above zero. An unwatched DLQ is a place where money-related events silently die.
4. **Replay manually and deliberately.** Inspect the message and the error, fix the cause (code or data), then move the message back to the original exchange
   (RabbitMQ management UI "Move messages" / the Shovel plugin, or a small replay script). Replaying is only safe because consumers are idempotent. Never auto-replay
   a DLQ in a loop: a poison message would cycle forever.
5. **Record why.** Keep the failure reason with the message (headers such as `x-death`, plus your own error text) so whoever triages does not have to guess.
6. **Business outcomes are not failures.** "Wrong amount" or "unknown order" should become a visible state in the domain (here `payment_review`), not a dead letter.
