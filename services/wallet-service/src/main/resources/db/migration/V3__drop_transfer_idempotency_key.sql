-- Every transfer now comes from exactly one confirmed transfer intent, and uq_transfer_intent
-- (unique on intent_id, added in V2) already guarantees "one intent, one transfer".
-- The per-sender idempotency key column from V1 is therefore redundant. Drop it, and its constraint.
alter table transfer drop constraint if exists uq_transfer_idempotency;
alter table transfer drop column if exists idempotency_key;
