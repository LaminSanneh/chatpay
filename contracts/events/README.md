# Event contracts

One example payload per event that crosses a service boundary on RabbitMQ (see `docs/events.md` for who sends and listens to what).
These files are the SHARED SOURCE OF TRUTH for the shape of each event, and every service tests against them:

| Who | How the fixtures are used |
|---|---|
| wallet-service (producer) | `EventContractTest` serialises the real event records and compares with the fixtures exactly; `EventPublishingIT` checks the messages that really arrive on the broker have the same shape |
| store-backend (producer of `store.*`, `order.paid`) | `EventContractsTest` compares the payloads it really writes to its outbox; the same test feeds the wallet fixtures through its consumer |
| chat-service (consumer) | `tests/contracts.test.ts` parses every fixture it consumes with the real zod schemas |
| everyone | `contracts/tests/test_contracts.py` (run by `make check`) checks the fixtures and `index.json` themselves |

## Rules
- Changing an event means changing its fixture IN THE SAME COMMIT. A producer change without a fixture change fails the producer's test; a fixture change that a consumer cannot read fails the consumer's test.
- Only ADD fields. Consumers ignore fields they do not know; producers never remove or retype one. A breaking change bumps `version` and gets a new fixture alongside the old one until every consumer is migrated.
- `null` in a payload is accepted where a fixture shows a value (an optional field that is empty); a different TYPE is not.
- Money is an integer in minor units (`amountMinor`, `commissionMinor`, `totalMinor`), currency a 3-letter code, ids are strings.
- Wallet events carry `kind` (`P2P`, `ORDER_PAYMENT`, `RELEASE`, `REFUND`). Consumers MUST check it before acting.
- `index.json` lists every fixture with its exchange, routing key, producer and consumers. Every `.json` here except `index.json` must be listed.
