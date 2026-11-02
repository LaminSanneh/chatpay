# mock-services

Permanent stand-ins that let us test our SCRIPTS (doctor, e2e, verify) without the real stack. Rules for this repo:
- No throw-away mock servers or background processes started from a terminal. Every mock lives here, is versioned, and has unit tests.
- Mock servers run in the FOREGROUND in their own terminal (`make mock-rabbit`, `make mock-stack`), never as hidden background jobs.
- The unit tests call the handlers directly (`handle()`), so `make check` starts nothing.

| Mock | Stands in for | Port | Data | Used by |
|---|---|---|---|---|
| `rabbitmq/server.py` | RabbitMQ management API (`GET /api/queues`) | 15673 (real one is 15672) | `rabbitmq/queues*.json` (re-read on every request) | `scripts/doctor.sh` (`RABBIT=...` or `RABBIT_FIXTURE=file`) |
| `stack/server.py` | Keycloak token endpoint, wallet, chat-service, store-backend (the parts the scripts call) | 9977 | `stack/catalog.json` | `scripts/e2e.sh`, `services/store-backend/verify.sh` |

Fixtures for doctor.sh's RabbitMQ report: `queues.json` (healthy, the default), `queues.no-consumers.json`, `queues.dead-letters.json`,
`queues.backlog.json`, `queues.not-created.json`. To add a case: drop a `queues.<name>.json` here and add a test in `tests/test_rabbitmq_mock.py`.

## What these mocks are NOT
They are not a model of the real services and they do not validate them. They prove that OUR SCRIPTS behave (parse the right fields, report the right
failure, exit with the right code). The real services are validated by their own suites (`npm test`, `mvn test`, `php artisan test`) and then by running
the real stack (`make doctor`, `./scripts/e2e.sh`). The stack mock accepts fake tokens (signature `y`), so it can never stand in for a real Keycloak when a
service verifies JWT signatures.

## Commands
    make check            static checks + all unit tests (starts nothing)
    make doctor-fixtures  see what each failure looks like in doctor.sh
    make mock-rabbit      own terminal; then in another:  make doctor-mock-rabbit
    make mock-stack       own terminal; then in another:  make e2e-mock   or   make verify-mock
