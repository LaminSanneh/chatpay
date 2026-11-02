-- module: transfer. A transfer intent is the server-side record of "this user wants to pay X to Y".
-- Money only moves when an intent is CONFIRMED; the intent id doubles as the idempotency key.
create table transfer_intent (
  id             uuid primary key default gen_random_uuid(),
  from_user_id   varchar(255) not null,
  to_user_id     varchar(255) not null,
  amount_minor   bigint       not null check (amount_minor > 0),
  currency       varchar(3)   not null,
  note           varchar(255),
  reference_type varchar(64),
  reference_id   varchar(128),
  status         varchar(16)  not null,      -- CREATED | COMPLETED | CANCELLED | EXPIRED
  transfer_id    uuid references transfer (id),
  created_at     timestamptz  not null default now(),
  updated_at     timestamptz  not null default now(),
  expires_at     timestamptz  not null
);
create index ix_intent_user_status on transfer_intent (from_user_id, status, expires_at);

-- every transfer now comes from exactly one confirmed intent
alter table transfer add column intent_id uuid;
create unique index uq_transfer_intent on transfer (intent_id) where intent_id is not null;
