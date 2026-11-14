#!/usr/bin/env bash
# Correlation ids end to end on the REAL stack: does one X-Correlation-Id follow a request through the wallet, its outbox event, RabbitMQ,
# the store's consumer, the store's own outbox event, and back out on RabbitMQ?
#
# It binds two throw-away queues (they delete themselves after 10 minutes) to wallet.events and store.events, makes payments with chosen
# ids, and reads the messages: the AMQP header x-correlation-id and the correlationId inside the payload must be the id that was sent.
# Needs everything running (docker compose up -d, wallet-service, chat-service, store-backend with ./dev.sh). Changes only what a normal payment changes.
#   ./scripts/e2e-correlation.sh        KC WALLET CHAT STORE RABBIT RABBIT_USER RABBIT_PASS override the defaults
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

KC=${KC:-http://localhost:8080/realms/chatpay}
WALLET=${WALLET:-http://localhost:8081}
CHAT=${CHAT:-http://localhost:4000}
STORE=${STORE:-http://localhost:8000}
RABBIT=${RABBIT:-http://localhost:15672}
RABBIT_USER=${RABBIT_USER:-chatpay}; RABBIT_PASS=${RABBIT_PASS:-chatpay}
RUN=$RANDOM$RANDOM
QW="e2e-corr-wallet-$RUN"; QS="e2e-corr-store-$RUN"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

ok=0; fail=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
bad()  { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail+1)); }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
rq() { curl -s -m 10 -u "$RABBIT_USER:$RABBIT_PASS" "$@"; }
tok() { curl -s -m 10 -d client_id=chatpay-web -d grant_type=password -d username="$1" -d password=password "$KC/protocol/openid-connect/token" | json 'd["access_token"]'; }
sub() { python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["sub"])' "$1" 2>/dev/null; }

# call METHOD URL TOKEN CORRELATION_ID [JSON]  ->  STATUS, BODY and RESPONSE_CID (the X-Correlation-Id the service answered with)
call() {
  local method=$1 url=$2 token=$3 cid=$4 body=${5:-}
  local args=(-s -m 20 -o /tmp/e2e-corr.body -D /tmp/e2e-corr.headers -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$cid" ] && args+=(-H "X-Correlation-Id: $cid")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/e2e-corr.body)
  RESPONSE_CID=$(grep -i '^x-correlation-id:' /tmp/e2e-corr.headers | head -1 | cut -d: -f2- | tr -d ' \r\n')
}

cleanup() { trap - EXIT; rq -X DELETE "$RABBIT/api/queues/%2F/$QW" >/dev/null; rq -X DELETE "$RABBIT/api/queues/%2F/$QS" >/dev/null; }
trap cleanup EXIT
trap 'exit 130' INT TERM

bind_queue() { # queue exchange routing-key
  rq -X PUT -H 'content-type: application/json' "$RABBIT/api/queues/%2F/$1" -d '{"durable":false,"auto_delete":false,"arguments":{"x-expires":600000}}' >/dev/null
  rq -X POST -H 'content-type: application/json' "$RABBIT/api/bindings/%2F/e/$2/q/$1" -d "{\"routing_key\":\"$3\"}" >/dev/null
}
# wait_event QUEUE FIELD VALUE -> EVENT_HEADER (AMQP x-correlation-id) and EVENT_CID (correlationId in the body) of the message whose FIELD equals VALUE
wait_event() {
  local i out
  for ((i=0; i<45; i++)); do
    out=$(rq -X POST -H 'content-type: application/json' "$RABBIT/api/queues/%2F/$1/get" -d '{"count":50,"ackmode":"ack_requeue_false","encoding":"auto"}' | python3 -c '
import sys, json
for m in json.load(sys.stdin):
    try: p = json.loads(m["payload"])
    except ValueError: continue
    if str(p.get(sys.argv[1])) == sys.argv[2]:
        print((m["properties"].get("headers") or {}).get("x-correlation-id", "") + " " + str(p.get("correlationId", "")))
        break
' "$2" "$3" 2>/dev/null)
    if [ -n "$out" ]; then EVENT_HEADER=${out% *}; EVENT_CID=${out#* }; return 0; fi
    sleep 1
  done
  return 1
}

echo "Preflight"
for url in "$KC/.well-known/openid-configuration" "$WALLET/actuator/health" "$CHAT/health" "$STORE/up"; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url")" = 200 ] || { echo "  FAIL  not reachable: $url  (./scripts/doctor.sh shows what is down)"; trap - EXIT; exit 2; }
done
[ -n "$(rq "$RABBIT/api/overview" | json 'd["rabbitmq_version"]')" ] || { echo "  FAIL  RabbitMQ management API not reachable at $RABBIT"; trap - EXIT; exit 2; }
bind_queue "$QW" wallet.events transfer.completed
bind_queue "$QS" store.events order.paid
echo "  ok    stack is up; listening on throw-away queues $QW and $QS"

ALICE=$(tok alice); BOB=$(tok bob)
[ -n "$ALICE" ] && [ -n "$BOB" ] || { echo "  FAIL  alice and bob cannot sign in"; exit 2; }
BOB_ID=$(sub "$BOB")
call POST "$WALLET/api/v1/dev/topup" "$ALICE" "" '{"amountMinor":50000}'

echo; echo "1. Every service answers with an id, and errors can be traced"
call GET "$WALLET/api/v1/wallet" "" "trace-401-$RUN";  [ "$STATUS" = 401 ] && [ "$RESPONSE_CID" = "trace-401-$RUN" ] && pass "wallet: a 401 echoes the client's id" || bad "wallet: a 401 echoes the client's id" "status $STATUS, id '$RESPONSE_CID'"
call POST "$STORE/api/v1/orders" "" "trace-401s-$RUN" '{}'; [ "$STATUS" = 401 ] && [ "$RESPONSE_CID" = "trace-401s-$RUN" ] && pass "store: a 401 echoes the client's id" || bad "store: a 401 echoes the client's id" "status $STATUS, id '$RESPONSE_CID'"
call GET "$CHAT/api/me" "" "trace-401c-$RUN";           [ "$STATUS" = 401 ] && [ "$RESPONSE_CID" = "trace-401c-$RUN" ] && pass "chat: a 401 echoes the client's id" || bad "chat: a 401 echoes the client's id" "status $STATUS, id '$RESPONSE_CID'"
for pair in "wallet|$WALLET/actuator/health" "store|$STORE/up" "chat|$CHAT/health"; do
  call GET "${pair#*|}" "" ""
  [[ "$RESPONSE_CID" =~ $UUID_RE ]] && pass "${pair%%|*}: a request without an id gets a generated UUID" || bad "${pair%%|*}: a request without an id gets a generated UUID" "got '$RESPONSE_CID'"
  call GET "${pair#*|}" "" "bad id!"
  [[ "$RESPONSE_CID" =~ $UUID_RE ]] && pass "${pair%%|*}: an invalid id is replaced, not echoed" || bad "${pair%%|*}: an invalid id is replaced, not echoed" "got '$RESPONSE_CID'"
done

echo; echo "2. A payment's id reaches the wallet's event (header AND payload)"
A="e2e-pay-$RUN"
call POST "$WALLET/api/v1/transfer-intents" "$ALICE" "$A" "{\"toUserId\":\"$BOB_ID\",\"amountMinor\":100,\"note\":\"correlation\"}"
INTENT=$(echo "$BODY" | json 'd["id"]')
call POST "$WALLET/api/v1/transfer-intents/$INTENT/confirm" "$ALICE" "$A"
[ "$STATUS" = 200 ] && [ "$RESPONSE_CID" = "$A" ] && pass "confirm succeeded and echoed the id" || bad "confirm succeeded and echoed the id" "status $STATUS, id '$RESPONSE_CID'"
if wait_event "$QW" intentId "$INTENT"; then
  [ "$EVENT_HEADER" = "$A" ] && pass "transfer.completed carries the AMQP header x-correlation-id = $A" || bad "transfer.completed carries the AMQP header" "header '$EVENT_HEADER'"
  [ "$EVENT_CID" = "$A" ] && pass "...and the same id inside the payload (so a republished event keeps it)" || bad "payload correlationId" "payload '$EVENT_CID'"
else bad "transfer.completed reached the throw-away queue" "is the wallet publishing to wallet.events?"; fi

echo; echo "3. A request without an id: the generated one is on the response AND on the event"
call POST "$WALLET/api/v1/transfer-intents" "$ALICE" "" "{\"toUserId\":\"$BOB_ID\",\"amountMinor\":100}"
INTENT2=$(echo "$BODY" | json 'd["id"]')
call POST "$WALLET/api/v1/transfer-intents/$INTENT2/confirm" "$ALICE" ""
GENERATED=$RESPONSE_CID
if wait_event "$QW" intentId "$INTENT2"; then
  [[ "$GENERATED" =~ $UUID_RE ]] && [ "$EVENT_HEADER" = "$GENERATED" ] && pass "the event carries the id the wallet generated ($GENERATED)" || bad "the event carries the generated id" "response '$GENERATED', event '$EVENT_HEADER'"
else bad "second transfer.completed arrived"; fi

echo; echo "4. The whole chain: payment -> wallet event -> store consumer -> order.paid, ONE id"
PRODUCT=$(curl -s -m 10 "$STORE/api/v1/products" | json 'd["items"][0]["id"]')
B="e2e-order-$RUN"
call POST "$STORE/api/v1/orders" "$ALICE" "order-req-$RUN" "{\"items\":[{\"productId\":$PRODUCT,\"quantity\":1}]}"
ORDER=$(echo "$BODY" | json 'd["id"]'); OINTENT=$(echo "$BODY" | json 'd["payment"]["intentId"]')
[ "$STATUS" = 201 ] && [ "$RESPONSE_CID" = "order-req-$RUN" ] && pass "the store answered the checkout with the client's id" || bad "checkout echoed the id" "status $STATUS, id '$RESPONSE_CID'"
call POST "$WALLET/api/v1/transfer-intents/$OINTENT/confirm" "$ALICE" "$B"
if wait_event "$QW" intentId "$OINTENT"; then
  [ "$EVENT_HEADER" = "$B" ] && pass "wallet event for the order payment carries $B" || bad "wallet event carries $B" "header '$EVENT_HEADER'"
else bad "the order payment's transfer.completed arrived"; fi
if wait_event "$QS" orderId "$ORDER"; then
  [ "$EVENT_HEADER" = "$B" ] && [ "$EVENT_CID" = "$B" ] && pass "order.paid (written by the store's consumer, published by its relay) still carries $B in header and payload" \
    || bad "order.paid carries $B" "header '$EVENT_HEADER', payload '$EVENT_CID': the store consumer or the relay dropped the id"
else bad "order.paid reached the throw-away queue" "are events:consume and outbox:relay running? see ./scripts/doctor.sh"; fi

echo; echo "$ok ok, $fail failed"
echo "To follow one payment in the logs, search every service's output for the id (e.g. $B)."
[ "$fail" = 0 ]
