# store-backend (Laravel 13 + Filament)

One Laravel app with three jobs. They share the same models and database; nothing "calls" Filament, Filament IS the admin UI of this app.

| Part | URL | Who |
|---|---|---|
| Store API (JSON) | `/api/v1/...` | the Next.js storefront and the chat app |
| Admin panel (Filament) | `/admin` | platform staff: roles `catalog-admin`, `wallet-admin` |
| Vendor panel (Filament) | `/vendor` | store owners: role `vendor` and a store |

`setup.sh` fetches a fresh Laravel skeleton, copies `overlay/` (all our code) on top, installs `filament/filament`,
`php-amqplib` and `firebase/php-jwt`, then migrates and seeds. Everything we wrote lives in `overlay/`.

## How it fits together
- **Identity** is Keycloak. The API validates the bearer token locally (JWKS, issuer, expiry), so a login on the chat app or the storefront
  works here too. The back office signs in with the authorization code flow (client `laravel-admin`); the local `users` table is just a copy of
  who has signed in (id = Keycloak `sub`) so Filament has someone to authenticate and vendors can be tied to their store.
- **Prices** come from this database. `POST /orders` reserves stock, then asks the wallet (service account, role `wallet-merchant`) for a payment
  intent for exactly that amount. The buyer confirms the intent in the wallet with their own token. A client can never set a price.
- **Payment arrives** as `transfer.completed` (kind `ORDER_PAYMENT`) from RabbitMQ; `events:consume` marks the order paid and writes `order.paid`
  to the outbox. A payment for an order we already cancelled is refunded automatically.
- **Payout:** vendor marks shipped, then delivered; `orders:settle` (or "Pay out now" in /admin) calls the wallet's `release` with the platform
  commission. Refunds go through the wallet's `refund` while the money is still in escrow. Every wallet call carries an idempotency key derived from the order id.
- **Events out** (outbox table, relayed by `outbox:relay`, exchange `store.events`): `store.opened`, `store.closed` (chat shows the store icon),
  `order.paid` (chat shows a gift-order bubble when the order was bought for the person you are chatting with).
- **Finance pages** in /admin ("Wallet corrections", and "Wallet" on a user) call the wallet's admin API with the signed-in admin's own token.
  Corrections are requested here and must be approved by a different admin. Filament has no database access to the wallet.

## Selling
Anyone signed in can apply for a store (`POST /api/v1/stores`, or the storefront's /sell page). It starts `pending` and is invisible. An admin activates it in
/admin (that announces `store.opened`, so the chat shows the store icon); from then on the owner can sign in to /vendor. No extra Keycloak role is needed.

## Keeping access honest
Back-office roles are copied from the token at sign-in, so `SyncBackOfficeAccess` re-reads them from Keycloak whenever the access token expires (every few minutes).
If Keycloak refuses (person disabled or signed out), they are signed out; if their roles changed, the panel re-checks access. Worst case, a revoked person keeps access
for one token lifetime.

## Money in this app
Integer minor units everywhere (100 = D1.00). The Filament form shows dalasi and converts on save.

## Files
    overlay/app/Services       OrderService (checkout, fulfilment, wallet events), WalletClient (service account), WalletAdminClient (admin token),
                               KeycloakJwt, AdminTokens, EventPublisher (outbox)
    overlay/app/Http           API controllers, Keycloak middleware (`kc`, `kc:optional`), back-office sign-in controller
    overlay/app/Filament       panels, resources (Product, Category, Store, Order, User), WalletCorrections page
    overlay/app/Console        events:consume, outbox:relay, orders:expire, orders:settle, store:seed-demo
    overlay/database           migrations (users are Keycloak identities; stores, products, orders, outbox)

## API
    GET  /api/v1/categories · /products?search=&category=&store=&page= · /products/hot · /products/{slug} · /stores/{slug}      public
    POST /api/v1/orders {items:[{productId,quantity}], giftFor?, context?:{type:"chat",roomId}, shipping?}                         token
    GET  /api/v1/orders · /orders/{id}      POST /api/v1/orders/{id}/cancel                                                         token
`POST /orders` answers with `payment.intentId`: confirm it in the wallet (`POST /api/v1/transfer-intents/{id}/confirm`) with the buyer's token.
One order = one store; a cart with several stores becomes several orders.

## Checking it
    ./setup.sh            install, migrate, seed and run the test suite (in-memory SQLite: it never touches your database)
    php artisan test      the suite on its own (catalog, checkout, payment events, payout/refund, store events, onboarding, audit, access, JWT)
    ./verify.sh           smoke test of the RUNNING stack: catalog, 401s, Keycloak sign-in, a real token against the API, and (if the wallet is up)
                          checkout -> confirm payment -> order becomes paid
Production: see `overlay/deploy/supervisor/store-backend.conf` for the three long-running processes.
Queue note: `store.wallet-events` now has a dead-letter queue. If the queue already exists from an earlier run, delete it once in the RabbitMQ UI (RabbitMQ will not
redeclare a queue with different arguments).

## Not verified
This code was written without access to Composer/Packagist. It passes `php -l`, and the JWT class and its tests were run against the real php-jwt library, but
the app as a whole has never been installed or run, and the other feature tests have never executed. Expect small fixes on the first run, especially in the Filament
classes (written against the Filament 4/5 API). See the root CHECKLIST.
