# ChatPay: chat + wallet + store, independently deployable

    apps/web                 Next.js chat app (port 3000): rooms, groups, mentions, payments, in-chat shop
    apps/store-web           Next.js storefront (port 3001): anonymous browsing, cart, checkout, orders
    services/chat-service    Node.js + TypeScript chat backend (port 4000): framework-agnostic core, Express + Socket.IO + Postgres
    services/wallet-service  Spring Boot 3.5 / Java 21 modular monolith (port 8081): ledger, accounts, transfers, escrow, admin
    services/store-backend   Laravel 13 + Filament (port 8000): store API, /admin, /vendor
    infra/keycloak           realm import (clients, roles, demo users with fixed ids)
    docker-compose.yml       Keycloak, Postgres x3 (wallet, chat, store), RabbitMQ

    Chat web ──► chat-service ◄── store.events / wallet.events ── RabbitMQ ──► store-backend ◄── Store web
        │                                                                         │   ▲
        └────────────────────► wallet-service ◄───────────────────────────────────┘   └── Filament /admin /vendor
                     (payments, with the user's own token)     (price, payout, refund: service account)
                          every app signs in with Keycloak (one realm, one client per app)

Rules that hold it together: each backend owns its data and nobody reads another's database; the wallet is the only place money is
written; services talk by HTTP APIs and events; the chat and the store each keep working when the other is switched off.

## Run it
    docker compose up -d                                   # Keycloak :8080, wallet DB :5433, chat DB :5434, RabbitMQ :5672/:15672
    (cd services/wallet-service && mvn spring-boot:run)    # :8081
    (cd services/chat-service && cp .env.example .env && npm install && npm run dev)   # :4000
    (cd apps/web && cp .env.example .env.local && npm install && npm run dev)          # :3000  chat
    (cd apps/store-web && cp .env.example .env.local && npm install && npm run dev)    # :3001  storefront
    (cd services/store-backend && ./setup.sh)                                          # once: Laravel + Filament, then see its README for the 4 processes (:8000)

Chat: http://localhost:3000 · Store: http://localhost:3001 · Back office: http://localhost:8000/admin (admin1 or finance1/finance2) and /vendor (bob).
Sign in as `alice`/`password` and, in a private window, `bob`/`password` (bob owns the demo store). All passwords are `password`.
Fixed user ids: alice 11111111-1111-4111-8111-111111111111, bob 22222222-2222-4222-8222-222222222222.

## Try the wallet API without the UI
    TOKEN=$(curl -s -d client_id=chatpay-web -d grant_type=password -d username=alice -d password=password \
      http://localhost:8080/realms/chatpay/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
    curl -H "Authorization: Bearer $TOKEN" localhost:8081/api/v1/wallet
    curl -XPOST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d '{"amountMinor":10000}' localhost:8081/api/v1/dev/topup

    # Pay in two steps: create an intent (no money moves), then confirm it. Confirming twice pays once.
    BOB=<bob's user id: the "sub" claim of his token, or his id in the Keycloak admin console>
    INTENT=$(curl -s -XPOST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "{\"toUserId\":\"$BOB\",\"amountMinor\":2500,\"note\":\"lunch\"}" localhost:8081/api/v1/transfer-intents \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
    curl -XPOST -H "Authorization: Bearer $TOKEN" localhost:8081/api/v1/transfer-intents/$INTENT/confirm
    curl -XPOST -H "Authorization: Bearer $TOKEN" localhost:8081/api/v1/transfer-intents/$INTENT/confirm   # same result, no second debit

See `CHECKLIST.md` for the build plan and `services/*/README.md` for each service.

## Merchant and admin flows with curl
    token() { curl -s -d client_id=chatpay-web -d grant_type=password -d username=$1 -d password=password \
      http://localhost:8080/realms/chatpay/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'; }
    SVC=$(curl -s -d client_id=laravel-service -d client_secret=dev-laravel-secret -d grant_type=client_credentials \
      http://localhost:8080/realms/chatpay/protocol/openid-connect/token | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

    # 1. the store backend creates an order payment (server-computed price); the buyer confirms it with their own token
    ALICE=$(token alice); ALICE_ID=11111111-1111-4111-8111-111111111111
    ORDER=$(curl -s -XPOST -H "Authorization: Bearer $SVC" -H 'Content-Type: application/json' \
      -d "{\"payerUserId\":\"$ALICE_ID\",\"storeId\":\"s1\",\"orderId\":\"order-1\",\"amountMinor\":5000}" \
      localhost:8081/api/v1/internal/transfer-intents | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
    curl -XPOST -H "Authorization: Bearer $ALICE" localhost:8081/api/v1/transfer-intents/$ORDER/confirm   # money goes to escrow

    # 2. delivery confirmed: pay the store minus a 10% commission (repeat the call: same result)
    curl -XPOST -H "Authorization: Bearer $SVC" -H 'Idempotency-Key: order-1-release' -H 'Content-Type: application/json' \
      -d '{"commissionMinor":500}' localhost:8081/api/v1/internal/orders/order-1/release

    # 3. finance: request a reversal, try to approve it yourself (refused), approve as the other admin
    F1=$(token finance1); F2=$(token finance2)
    ACTION=$(curl -s -XPOST -H "Authorization: Bearer $F1" -H 'Content-Type: application/json' \
      -d '{"reasonCode":"WRONG_RECIPIENT","reason":"Sent to the wrong person"}' \
      localhost:8081/api/v1/admin/transfers/<transfer id>/reversal | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
    curl -XPOST -H "Authorization: Bearer $F1" localhost:8081/api/v1/admin/actions/$ACTION/approve   # 403 FOUR_EYES
    curl -XPOST -H "Authorization: Bearer $F2" localhost:8081/api/v1/admin/actions/$ACTION/approve   # appends the reversal entries
    curl -H "Authorization: Bearer $F2" localhost:8081/api/v1/admin/reconciliation                    # []
