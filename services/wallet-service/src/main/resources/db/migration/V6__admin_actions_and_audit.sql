-- Finance-ops corrections. Nothing here edits money history: an approved action APPENDS new ledger entries.
create table admin_action (
  id                    uuid primary key default gen_random_uuid(),
  type                  varchar(16)  not null check (type in ('ADJUSTMENT', 'REVERSAL')),
  status                varchar(16)  not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  account_id            uuid,                       -- ADJUSTMENT: the account to correct
  transfer_id           uuid,                       -- REVERSAL: the transfer being undone
  direction             varchar(6),                 -- ADJUSTMENT: CREDIT or DEBIT on account_id
  amount_minor          bigint       not null check (amount_minor > 0),
  currency              varchar(3)   not null,
  reason_code           varchar(32)  not null,
  reason                varchar(500) not null,
  created_by            varchar(255) not null,
  created_at            timestamptz  not null default now(),
  decided_by            varchar(255),
  decided_at            timestamptz,
  decision_note         varchar(500),
  ledger_transaction_id uuid,
  -- four-eyes rule enforced by the database itself: whoever asked cannot approve
  constraint ck_four_eyes check (status <> 'APPROVED' or decided_by <> created_by)
);
create unique index uq_admin_reversal_once on admin_action (transfer_id)
  where type = 'REVERSAL' and status in ('PENDING', 'APPROVED');
create index ix_admin_action_status on admin_action (status, created_at desc);

create table admin_audit_log (
  id         uuid primary key default gen_random_uuid(),
  actor      varchar(255) not null,         -- Keycloak subject of the admin
  actor_name varchar(255),
  action     varchar(64)  not null,
  target_type varchar(32),
  target_id  varchar(128),
  detail     text,
  created_at timestamptz  not null default now()
);
create index ix_audit_created on admin_audit_log (created_at desc);
create trigger admin_audit_log_append_only before update or delete on admin_audit_log
  for each row execute function forbid_mutation();
