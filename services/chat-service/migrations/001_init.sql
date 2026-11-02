-- chat-service schema. Applied by src/adapters/postgres/migrate.ts (tracked in schema_migrations).

create table users (
  id           text primary key,                 -- Keycloak "sub"
  username     text        not null,
  display_name text        not null,
  last_seen_at timestamptz not null default now()
);

-- Projection of the ecommerce side (fed by store.* events). Separate table so a store can be recorded
-- even before its owner has ever opened the chat.
create table user_stores (
  user_id    text primary key,
  store_id   text not null,
  store_name text not null,
  store_slug text not null
);

create table rooms (
  id         uuid primary key default gen_random_uuid(),
  kind       text        not null check (kind in ('direct', 'group')),
  name       text,
  visibility text        not null check (visibility in ('public', 'private')),
  direct_key text unique,                         -- sorted "idA:idB": one DM per pair
  created_by text        not null,
  created_at timestamptz not null default now()
);

create table room_members (
  room_id       uuid   not null references rooms (id) on delete cascade,
  user_id       text   not null,
  role          text   not null check (role in ('owner', 'admin', 'member')),
  joined_at     timestamptz not null default now(),
  last_read_seq bigint not null default 0,        -- read cursor: messages with seq <= this are read
  primary key (room_id, user_id)
);
create index ix_room_members_user on room_members (user_id);

create table room_invites (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references rooms (id) on delete cascade,
  invitee_id   text not null,
  inviter_id   text not null,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);
create unique index uq_pending_invite on room_invites (room_id, invitee_id) where status = 'pending';
create index ix_invites_invitee on room_invites (invitee_id) where status = 'pending';

create table messages (
  seq        bigserial primary key,               -- strictly increasing: cursor for history and read state
  id         uuid not null unique default gen_random_uuid(),
  room_id    uuid not null references rooms (id) on delete cascade,
  sender_id  text not null,
  kind       text not null check (kind in ('text', 'payment')),
  text       text,
  payment    jsonb,
  mentions   text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index ix_messages_room_seq on messages (room_id, seq desc);
-- one payment bubble per wallet transfer, even if the event is delivered twice
create unique index uq_payment_transfer on messages ((payment ->> 'transferId')) where payment is not null;
