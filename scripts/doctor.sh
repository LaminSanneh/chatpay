#!/usr/bin/env bash
# Is the whole stack up, and are events flowing? Read-only; safe to run any time.
#   ./scripts/doctor.sh
# Override addresses with env vars: KC WALLET CHAT STORE CHAT_WEB STORE_WEB RABBIT (management API) RABBIT_USER RABBIT_PASS
# Testing the RabbitMQ report without a broker (permanent mocks live in mock-services/):
#   RABBIT_FIXTURE=mock-services/rabbitmq/queues.dead-letters.json ./scripts/doctor.sh     read a static fixture file, no server at all
#   make mock-rabbit   (own terminal)   then   RABBIT=http://127.0.0.1:15673 ./scripts/doctor.sh      use the mock management API
KC=${KC:-http://localhost:8080}
WALLET=${WALLET:-http://localhost:8081}
CHAT=${CHAT:-http://localhost:4000}
STORE=${STORE:-http://localhost:8000}
CHAT_WEB=${CHAT_WEB:-http://localhost:3000}
STORE_WEB=${STORE_WEB:-http://localhost:3001}
RABBIT=${RABBIT:-http://localhost:15672}
RABBIT_USER=${RABBIT_USER:-chatpay}; RABBIT_PASS=${RABBIT_PASS:-chatpay}

down=0
row()  { printf '  %-30s %s\n' "$1" "$2"; }
http() { # name url [grep-pattern]
  local code; code=$(curl -s -o /tmp/doctor.body -w '%{http_code}' -m 4 "$2" 2>/dev/null)
  if [ "${code:0:1}" = 2 ] || [ "${code:0:1}" = 3 ]; then
    if [ -n "${3:-}" ] && ! grep -q "$3" /tmp/doctor.body; then row "$1" "UP but unexpected answer (wanted '$3')"; down=$((down+1)); else row "$1" "up"; fi
  else row "$1" "DOWN  ($2 -> ${code:-no answer})"; down=$((down+1)); fi
}
port() { # name host port
  if (exec 3<>"/dev/tcp/$2/$3") 2>/dev/null; then row "$1" "up (port $3)"; else row "$1" "DOWN (nothing on $2:$3)"; down=$((down+1)); fi
}

echo "Infrastructure (docker compose up -d)"
http "Keycloak realm" "$KC/realms/chatpay" '"realm"'
port "Postgres: wallet" localhost 5433
port "Postgres: chat" localhost 5434
port "Postgres: store" localhost 5435
port "RabbitMQ (AMQP)" localhost 5672

echo; echo "Services"
http "wallet-service" "$WALLET/actuator/health" '"UP"'
http "chat-service" "$CHAT/health" '"ok"'
http "store-backend" "$STORE/up"
http "chat web" "$CHAT_WEB/"
http "store web" "$STORE_WEB/"

echo; echo "Keycloak issuer (the #1 cause of 'invalid token': services and browsers must see the SAME address)"
issuer=$(curl -s -m 4 "$KC/realms/chatpay/.well-known/openid-configuration" | python3 -c 'import sys,json; print(json.load(sys.stdin)["issuer"])' 2>/dev/null)
if [ "$issuer" = "http://localhost:8080/realms/chatpay" ]; then row "issuer" "ok ($issuer)"; else row "issuer" "UNEXPECTED: '${issuer:-unreachable}' (services expect http://localhost:8080/realms/chatpay)"; down=$((down+1)); fi

echo; echo "RabbitMQ queues (consumers = who is listening; ready = waiting; dlq must be 0)"
if [ -n "${RABBIT_FIXTURE:-}" ]; then
  echo "  NOTE: these queues come from a FIXTURE FILE ($RABBIT_FIXTURE), not from a live broker"
  queues=$(cat "$RABBIT_FIXTURE" 2>/dev/null)
  unreachable="fixture file not readable: $RABBIT_FIXTURE"
else
  queues=$(curl -s -m 4 -u "$RABBIT_USER:$RABBIT_PASS" "$RABBIT/api/queues" 2>/dev/null)
  unreachable="management API not reachable at $RABBIT (is RabbitMQ up?)"
fi
if [ -z "$queues" ] || ! echo "$queues" | python3 -c 'import sys,json; json.load(sys.stdin)' 2>/dev/null; then
  row "queues" "$unreachable"; down=$((down+1))
else
  echo "$queues" | python3 -c '
import sys, json
have = {q["name"]: q for q in json.load(sys.stdin)}
expect = [("chat.wallet-events", "chat-service"), ("chat.store-events", "chat-service"),
          ("store.wallet-events", "store-backend: events:consume"), ("store.wallet-events.dlq", "dead letters")]
bad = 0
for name, owner in expect:
    q = have.get(name)
    if q is None:
        print(f"  {name:<30} not created yet ({owner} has not connected since RabbitMQ started)"); bad += 1; continue
    ready, unacked, consumers = q.get("messages_ready", 0), q.get("messages_unacknowledged", 0), q.get("consumers", 0)
    note = ""
    if name.endswith(".dlq"):
        if ready: note = "  <-- DEAD LETTERS waiting for a person, see docs/events.md"; bad += 1
    elif consumers == 0: note = f"  <-- NOBODY IS LISTENING ({owner} is not running or not connected)"; bad += 1
    elif ready > 20: note = "  <-- backlog growing"
    print(f"  {name:<30} consumers={consumers} ready={ready} unacked={unacked}{note}")
sys.exit(1 if bad else 0)
' || down=$((down+1))
fi

echo; echo "Events stuck in an outbox? (needs docker compose in this directory; n/a otherwise)"
pgq() { docker compose exec -T "$1" psql -U "$2" -d "$3" -Atc "$4" 2>/dev/null; }
n=$(pgq wallet-db wallet wallet "select count(*) from event_publication where completion_date is null"); row "wallet: unpublished events" "${n:-n/a}"
n=$(pgq store-db store store "select count(*) from outbox_events where published_at is null"); row "store: unpublished events" "${n:-n/a}"

echo; if [ "$down" = 0 ]; then echo "Everything looks fine."; else echo "$down problem(s) found."; fi
[ "$down" = 0 ]
