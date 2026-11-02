-- Gift-order bubbles: a message of kind 'order' carries a snapshot of the order (fed by `order.paid` events).
alter table messages add column order_data jsonb;
alter table messages drop constraint messages_kind_check;
alter table messages add constraint messages_kind_check check (kind in ('text', 'payment', 'order'));
-- one bubble per order, even if the event is delivered twice
create unique index uq_order_message on messages ((order_data ->> 'orderId')) where order_data is not null;
