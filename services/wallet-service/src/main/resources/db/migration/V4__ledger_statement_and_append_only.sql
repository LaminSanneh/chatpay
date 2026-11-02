-- Statement support: ordering cursor, running balance, and what each entry was for.
alter table ledger_entry add column seq bigserial;
alter table ledger_entry add column balance_after bigint;                       -- balance of the account right after this entry
alter table ledger_entry add column kind varchar(32) not null default 'TRANSFER';
alter table ledger_entry add column reference_type varchar(64);
alter table ledger_entry add column reference_id varchar(128);
create unique index uq_ledger_entry_seq on ledger_entry (seq);
create index ix_ledger_entry_account_seq on ledger_entry (account_id, seq desc);

-- classify rows written before this migration (dev top-ups used a fixed description)
update ledger_entry set kind = 'TOPUP' where description = 'dev top-up';

-- Money history is APPEND-ONLY. Corrections are new, opposite entries, never edits.
-- (ledger_account.balance_minor is a running total maintained by the ledger module and reconciled against entries.)
create function forbid_mutation() returns trigger language plpgsql as $$
begin
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name using errcode = '55000';
end $$;

create trigger ledger_entry_append_only before update or delete on ledger_entry
  for each row execute function forbid_mutation();
create trigger transfer_append_only before update or delete on transfer
  for each row execute function forbid_mutation();
