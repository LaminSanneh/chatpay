# chat-service (TypeScript, framework-agnostic core)

    src/core        ChatService + ports (interfaces). Pure TypeScript. No express/socket.io/amqp imports.
    src/adapters    memory-store (tests, quick dev) and postgres (+ migrations/ run on start). Swap for your own DB.
    src/auth        JWT verification (jose + Keycloak JWKS). Implements the TokenVerifier port.
    src/http        Express REST adapter.
    src/ws          Socket.IO adapter.
    src/messaging   RabbitMQ consumers: wallet events (payment bubbles) and store events (store icon).
    src/main.ts     Composition root: wires adapters to the core.

Run: `cp .env.example .env && npm install && npm run dev` (DATABASE_URL set = Postgres, empty = in-memory)
Test: `npm test` (in-memory + transport). Add `TEST_DATABASE_URL=postgres://...` to run every scenario on Postgres too.

## Reusing parts
- Use the **core** inside your existing chat app: `new ChatService(yourUsers, yourRooms, yourMessages)`.
- Or keep this service and replace only the repositories.
- Porting to NestJS: wrap `ChatService` in a provider (`{provide: ChatService, useFactory: ...}`), turn `src/http` into
  controllers and `src/ws` into a `@WebSocketGateway`. The core and adapters move over untouched.

## REST (all need a bearer token)
    GET  /api/me · GET /api/users?q=
    GET  /api/rooms                          my rooms with unreadCount, mentionCount, lastMessage
    GET  /api/rooms/public?q=                public groups (private ones never appear)
    POST /api/rooms {name, visibility, inviteeIds[]}      POST /api/rooms/direct {userId}
    POST /api/rooms/:id/join   /leave   /invites {userIds[]}   /read {upTo?}
    GET  /api/rooms/:id/messages?before=<seq>&limit=      POST /api/rooms/:id/messages {text, mentions[]}  (bots; web uses the socket)
    GET  /api/invites · POST /api/invites/:id/accept | decline

## Socket.IO
connect with `auth: { token }` (a function, so reconnects get a fresh token)
emit    `message:send {roomId,text,mentions[]}` (ack) · `typing {roomId}` · `room:read {roomId,upTo?}` (ack)
receive `message:new` · `mention` · `room:new` · `room:updated` · `invite:new` · `room:read` · `typing`

## Events consumed (RabbitMQ)
`wallet.events` / `transfer.completed`  -> payment bubble in the matching 1:1 room (kind P2P only)
`store.events`  / `store.opened|closed` -> store icon on the owner's profile
