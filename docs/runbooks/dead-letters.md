# Runbook: dead letters

A **dead letter** is an event a consumer could not process: either it can never work (broken JSON, a payload that fails validation: dead-lettered at once) or it kept failing through every retry (database down for longer than the retry window). It waits in a dead-letter queue until a person decides. Nothing replays it automatically.

| Queue | Holds failed events of | Fixed by |
|---|---|---|
| `chat.wallet-events.dlq` | chat-service, from the wallet (payment bubbles) | `npm run dlq:*` in `services/chat-service` |
| `chat.store-events.dlq` | chat-service, from the store (store icon, gift bubbles) | the same |
| `store.wallet-events.dlq` | store-backend, from the wallet (order paid, settlements) | the same (same header convention) |

## 1. Notice
- `make doctor` shows each queue and flags `DEAD LETTERS waiting for a person`. Run it (or wire it into monitoring: it exits non-zero) regularly. A dead-letter queue nobody watches is where money-related events silently die.
- `./scripts/e2e-resilience.sh` proves the mechanism end to end after a change.

## 2. Look
    cd services/chat-service
    AMQP_URL=amqp://chatpay:chatpay@localhost:5672 npm run dlq:list -- chat.wallet-events.dlq
Each entry shows `transient` or `permanent`, how many retries it had, when it failed, the original queue and routing key, the error class and message, and the start of the body. Listing changes nothing.
The full failure detail (stack, first and last failure time) is in the message headers: RabbitMQ management UI -> Queues -> the queue -> Get messages.

The `cid=` shown for each entry is the correlation id of the request that caused the event: search the logs of the wallet, store and chat for it to see the whole story (what the user did, which services handled it, where it failed).

## 3. Decide
| What you see | Meaning | Do |
|---|---|---|
| `transient`, retries = the maximum, error mentions the database or a connection | the dependency was down longer than the retry window | make sure it is healthy now, then **replay** |
| `permanent`, `SyntaxError` / `ZodError` | the payload is wrong: a producer bug or an incompatible change | fix the PRODUCER (compare with `contracts/events/`), then replay the corrected events if they still matter, or discard |
| `transient` but the error is a bug in our handler | a code bug | fix and deploy the consumer, then **replay** |
| the same message again after a replay (`replayed 1x before`) | the cause is NOT fixed | stop: do not replay in a loop; find the cause |

## 4. Replay
Replaying is safe because every consumer is idempotent (chat: unique indexes on transfer and order ids; store: it checks the order's status). It is still deliberate:

    npm run dlq:replay -- chat.wallet-events.dlq                         # dry run: shows what WOULD be replayed
    npm run dlq:replay -- chat.wallet-events.dlq --limit 1 --yes         # try ONE first
    npm run dlq:replay -- chat.wallet-events.dlq --match 'db down' --yes # only those whose body or error contains the text
    npm run dlq:replay -- chat.wallet-events.dlq --yes                   # up to 10 (the default limit; raise it with --limit)

- Each message goes back on its ORIGINAL queue with a fresh retry budget and a trail (`x-replay-count`, `x-replayed-at`, `x-replayed-from`). Its original routing key is kept, so the consumer treats it exactly as before.
- The copy is confirmed by the broker before the dead letter is removed. If anything fails mid-way the rest stay in the dead-letter queue and the tool says so.
- Dead letters written by the old store consumer (before retries existed) have no `x-original-queue`: the tool skips them and says so. Replay them with `--to store.wallet-events`.
- After replaying, run `make doctor`: the dead-letter count should fall and `retrying=` should drain.

## 5. Discard
A dead letter that should not be replayed (a test message, an event for something deleted, a producer bug already corrected another way): write down what it was (`dlq:list` output is enough), then remove it in the RabbitMQ management UI (Queues -> the queue -> Get messages with "Nack/reject requeue false", or Purge for the whole queue). There is deliberately no discard command: a one-way delete should be a conscious act in a UI that shows what is being deleted.

## 6. Afterwards
Ask why it happened. A dead letter is a symptom: a dependency without enough headroom, a producer change that skipped the contract fixtures, an alert nobody saw. Fix that, or it will come back.
