-- Merchant-created intents (ecommerce orders) and per-order escrow bookkeeping.
alter table transfer_intent add column kind varchar(16) not null default 'P2P';   -- P2P | ORDER
alter table transfer_intent add column created_by varchar(255);                   -- user id, or service client id for ORDER
alter table transfer_intent add column store_id varchar(64);
-- one live (open or paid) payment intent per order
create unique index uq_intent_order_active on transfer_intent (reference_id)
  where kind = 'ORDER' and status in ('CREATED', 'COMPLETED');

alter table transfer add column kind varchar(16) not null default 'P2P';           -- P2P | ORDER_PAYMENT

-- What an order has paid into escrow. Insert-only: what is still held = paid_minor - sum(settlement.amount_minor).
create table order_escrow (
  order_id         varchar(128) primary key,
  payer_user_id    varchar(255) not null,
  payer_account_id uuid         not null,
  store_id         varchar(64)  not null,
  currency         varchar(3)   not null,
  paid_minor       bigint       not null check (paid_minor > 0),
  transfer_id      uuid         not null references transfer (id),
  created_at       timestamptz  not null default now()
);

-- Money leaving escrow: RELEASE to the store (minus commission) or REFUND to the buyer. Insert-only.
create table settlement (
  id                    uuid primary key default gen_random_uuid(),
  order_id              varchar(128) not null references order_escrow (order_id),
  kind                  varchar(16)  not null check (kind in ('RELEASE', 'REFUND')),
  amount_minor          bigint       not null check (amount_minor > 0),
  commission_minor      bigint       not null default 0 check (commission_minor >= 0),
  idempotency_key       varchar(128) not null unique,
  ledger_transaction_id uuid         not null,
  created_by            varchar(255) not null,
  created_at            timestamptz  not null default now(),
  check (commission_minor <= amount_minor)
);
create index ix_settlement_order on settlement (order_id);

create trigger order_escrow_append_only before update or delete on order_escrow
  for each row execute function forbid_mutation();
create trigger settlement_append_only before update or delete on settlement
  for each row execute function forbid_mutation();
