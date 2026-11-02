# wallet-service (Spring Boot modular monolith)

Run: `docker compose up -d` (repo root), then `mvn spring-boot:run` here. Needs Java 21.
API (all need a Keycloak bearer token):

    GET  /api/v1/wallet                          my balance (wallet is created on first call)
    POST /api/v1/transfer-intents                step 1: declare a payment. NO MONEY MOVES.      -> 201 intent
    POST /api/v1/transfer-intents/{id}/confirm   step 2: pay. 200 only if COMPLETED, else 409 with the real state
    POST /api/v1/transfer-intents/{id}/cancel    cancel an unconfirmed intent
    GET  /api/v1/transfer-intents/{id}           what happened to this attempt? (recovery)
    GET  /api/v1/transfer-intents?open=true      my payments still waiting for confirmation (recovery)
    GET  /api/v1/transfers[/{id}]                completed transfers (history, receipts)
    POST /api/v1/dev/topup                       dev profile only

There is no "POST /transfers": money only moves when an intent is confirmed.

    GET  /api/v1/wallet/entries?before=&limit=   my statement, newest first (running balance, kind, reference)

    Store backend (role wallet-merchant)
    POST /api/v1/internal/transfer-intents            create an ORDER payment intent {payerUserId, storeId, orderId, amountMinor, note}
    POST /api/v1/internal/orders/{id}/release         pay the store {amountMinor?, commissionMinor}      header Idempotency-Key
    POST /api/v1/internal/orders/{id}/refund          give held money back to the buyer {amountMinor?}   header Idempotency-Key

    Finance (role wallet-admin; all attributed to the admin's own token)
    GET  /api/v1/admin/users/{userId}/wallet          balance (the lookup is audited)
    GET  /api/v1/admin/users/{userId}/transfers
    GET  /api/v1/admin/accounts/{accountId}/entries
    GET  /api/v1/admin/reconciliation                 [] = cached balances match the entries
    GET  /api/v1/admin/actions?status=PENDING
    POST /api/v1/admin/adjustments                    request a correction {accountId, direction, amountMinor, reasonCode, reason}
    POST /api/v1/admin/transfers/{id}/reversal        request undoing a person-to-person transfer {reasonCode, reason}
    POST /api/v1/admin/actions/{id}/approve|reject    a DIFFERENT admin decides

## Payments via server-issued intents
The server, not the browser, owns the identity and state of every payment attempt.

    CREATED --confirm--> COMPLETED          (money moved, event published)
       |-----cancel----> CANCELLED
       `-----timeout---> EXPIRED            (default 10 min, `wallet.intent-ttl-seconds`)

- The intent id is the idempotency key. Confirming twice returns the original result and pays once;
  concurrent confirms are serialised by a row lock on the intent.
- Confirm is atomic: transfer row + ledger entries + intent status + outbox event commit together or not at all.
- Insufficient funds rolls confirm back and leaves the intent CREATED: top up, confirm again.
- After a crash, refresh or device switch the client asks `GET ...?open=true` / `GET .../{id}` for the truth.
- Not built yet: step-up auth (PIN) on confirm, fee quotes, limits/fraud checks, recipient display name on the review step.

## Module boundaries

    shared      (open)  errors, security (roles from Keycloak), messaging config. No business logic.
    ledger              double-entry bookkeeping, statement, reconciliation. Knows only account ids and amounts.
    account             external identity (issuer+subject) -> internal account id; USER / STORE / SYSTEM accounts. -> ledger
    settlement          per-order escrow holds, RELEASE to store (minus commission), REFUND to buyer. -> account, ledger
    transfer            intents (person-to-person and order), transfers, TransferCompleted event. -> account, ledger, settlement
    admin               finance operations: inspect, request/approve corrections, audit.   -> account, ledger, transfer

Dependencies point one way; there are no cycles. Rules, enforced by `ModularityTests` (Spring Modulith):
1. A module's **root package** is its public API (interfaces, records, events). Other modules may use it.
2. Everything in `<module>.internal.*` is private. Entities, repositories, services, controllers live there.
3. Talk to another module through its API interface, never its repository or entity.
4. No foreign keys across modules in the database; reference by id only.
5. Modules in the same JVM may also react to each other's events (`@ApplicationModuleListener`),
   which is how you later split one out with minimal change.

To extract a module into its own microservice: its root-package API becomes a REST/gRPC client
(or events), its tables move to its own database. Nothing else has to change.

## Money rules
- **Append-only:** `ledger_entry`, `transfer`, `order_escrow`, `settlement` and `admin_audit_log` reject UPDATE and DELETE
  (database triggers). A mistake is fixed by appending new, opposite entries. `ledger_account.balance_minor` is the one running
  total, changed only by the ledger module and checked by `GET /admin/reconciliation`.
- **Server decides the price:** order intents are created by the store backend (`wallet-merchant` role), never by the buyer's client.
- **Escrow:** order payments go buyer -> `escrow`; later RELEASE (store gets amount minus commission, platform-revenue gets the commission)
  or REFUND (buyer). What is still held = paid minus settled, per order, under a row lock.
- **Four eyes:** an admin correction is requested, then approved by a *different* admin. A database constraint enforces it.
- **Accounts that may go negative:** only `treasury` (dev money source) and `adjustments` (finance suspense account).

## Roles (Keycloak realm roles)
    wallet-merchant   service account of the store backend: /api/v1/internal/**
    wallet-admin      finance staff: /api/v1/admin/**
