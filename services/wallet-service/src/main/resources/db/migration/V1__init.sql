-- NOTE: no foreign keys between tables of DIFFERENT modules. The module boundary
-- is also a data boundary: account / ledger / transfer only reference each other by id.

-- module: account
create table account (
  id            uuid primary key default gen_random_uuid(),
  owner_issuer  varchar(255) not null,
  owner_subject varchar(255) not null,
  currency      varchar(3)   not null,
  type          varchar(16)  not null,
  created_at    timestamptz  not null default now(),
  constraint uq_account_owner unique (owner_issuer, owner_subject, currency)
);

-- module: ledger
create table ledger_account (
  account_id     uuid primary key,
  currency       varchar(3) not null,
  balance_minor  bigint     not null default 0,
  allow_negative boolean    not null default false,
  constraint ck_balance_non_negative check (allow_negative or balance_minor >= 0)
);

create table ledger_entry (
  id             uuid primary key default gen_random_uuid(),
  transaction_id uuid         not null,
  account_id     uuid         not null references ledger_account (account_id),
  direction      varchar(6)   not null,
  amount_minor   bigint       not null check (amount_minor > 0),
  currency       varchar(3)   not null,
  description    varchar(255),
  created_at     timestamptz  not null default now()
);
create index ix_ledger_entry_account on ledger_entry (account_id, created_at desc);
create index ix_ledger_entry_tx on ledger_entry (transaction_id);

-- module: transfer
create table transfer (
  id              uuid primary key default gen_random_uuid(),
  from_account_id uuid         not null,
  to_account_id   uuid         not null,
  from_user_id    varchar(255) not null,
  to_user_id      varchar(255) not null,
  amount_minor    bigint       not null check (amount_minor > 0),
  currency        varchar(3)   not null,
  note            varchar(255),
  reference_type  varchar(64),
  reference_id    varchar(128),
  idempotency_key varchar(128) not null,
  status          varchar(16)  not null,
  created_at      timestamptz  not null default now(),
  constraint uq_transfer_idempotency unique (from_account_id, idempotency_key)
);
create index ix_transfer_from_user on transfer (from_user_id, created_at desc);
create index ix_transfer_to_user on transfer (to_user_id, created_at desc);
