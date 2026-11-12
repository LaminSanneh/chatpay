#!/usr/bin/env bash
# Resilience end-to-end: does the event pipeline survive real outages, with every event arriving EXACTLY ONCE?
# It drives the real stack through its APIs and stops/starts real infrastructure with docker compose. It never changes code or data
# beyond what a normal payment does (plus, in `poison-message`, two junk messages it removes again).
#
#   ./scripts/e2e-resilience.sh                  all scenarios
#   ./scripts/e2e-resilience.sh chat-db-outage   one scenario (several can be named)
#   ./scripts/e2e-resilience.sh --list           what each scenario does (touches nothing)
#
# Needs the whole stack up (docker compose up -d, wallet-service, chat-service, store-backend) and run from a checkout that has the
# docker-compose.yml. Whatever happens, the script starts rabbitmq and chat-db again when it ends.
#   KC WALLET CHAT RABBIT (management API) RABBIT_USER RABBIT_PASS DC="docker compose"  override the defaults.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

KC=${KC:-http://localhost:8080/realms/chatpay}
WALLET=${WALLET:-http://localhost:8081}
CHAT=${CHAT:-http://localhost:4000}
RABBIT=${RABBIT:-http://localhost:15672}
RABBIT_USER=${RABBIT_USER:-chatpay}; RABBIT_PASS=${RABBIT_PASS:-chatpay}
DC=${DC:-docker compose}
CHAT_Q=chat.wallet-events
STORE_Q=store.wallet-events
CHAT_DLQ=chat.wallet-events.dlq

SCENARIOS=(chat-db-outage poison-message broker-outage)
describe() {
  case $1 in
    chat-db-outage) echo "The chat database goes down while a payment happens. The chat service must stay up (/health 200, /ready 503). Its consumer fails, the failure is classified as transient, the event is retried with backoff, and after the database returns the payment bubble appears exactly once. Nothing is dead-lettered." ;;
    poison-message) echo "Two unreadable messages (broken JSON, wrong types) are put on the chat's queue. They are dead-lettered at once with the error in their headers, never retried, and a normal payment right after is still delivered exactly once." ;;
    broker-outage)  echo "RabbitMQ goes down while a payment happens. Money still moves (the wallet does not need the broker) and the event waits in the wallet's outbox. After the broker returns the wallet's timer republishes it, the chat and the store consumers reconnect by themselves, and the payment bubble appears exactly once (allow up to ~2 minutes)." ;;
  esac
}

LIST=0; SELECTED=()
for arg in "$@"; do
  case $arg in
    --list) LIST=1 ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "unknown option: $arg (try --help)"; exit 2 ;;
    *) if [[ " ${SCENARIOS[*]} " == *" $arg "* ]]; then SELECTED+=("$arg"); else echo "unknown scenario: $arg (try --list)"; exit 2; fi ;;
  esac
done
[ ${#SELECTED[@]} -eq 0 ] && SELECTED=("${SCENARIOS[@]}")
if [ "$LIST" = 1 ]; then for s in "${SCENARIOS[@]}"; do printf '%-16s %s\n\n' "$s" "$(describe "$s")"; done; exit 0; fi

# ---------------------------------------------------------------- reporting
ok=0; fail=0; skip=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
bad()  { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail+1)); }
skp()  { echo "  skip  $1${2:+  ($2)}"; skip=$((skip+1)); }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }

# ---------------------------------------------------------------- always leave the infrastructure running
restore() {
  trap - EXIT
  echo; echo "Restoring infrastructure (rabbitmq, chat-db)..."
  $DC start rabbitmq chat-db >/dev/null 2>&1
}
trap restore EXIT
trap 'exit 130' INT TERM

# ---------------------------------------------------------------- helpers
tok() { curl -s -m 10 -d client_id=chatpay-web -d grant_type=password -d username="$1" -d password=password "$KC/protocol/openid-connect/token" | json 'd["access_token"]'; }
sub() { python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["sub"])' "$1" 2>/dev/null; }
call() {   # call METHOD URL TOKEN [JSON]  ->  STATUS and BODY
  local method=$1 url=$2 token=$3 body=${4:-}
  local args=(-s -m 30 -o /tmp/e2e-res.body -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/e2e-res.body)
}
balance() { call GET "$WALLET/api/v1/wallet" "$1"; echo "$BODY" | json 'd["balanceMinor"]'; }
wait_for() { local secs=$1; shift; local i; for ((i=0; i<secs; i++)); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1; }
quiet() { "$@" >/dev/null 2>&1; }
http_code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$1"; }
# The service under test must SURVIVE the outage: a crashed process is the failure this script exists to catch.
still_up() { [ "$(http_code "$CHAT/health")" = 200 ] && pass "chat-service is still running $1" || bad "chat-service is still running $1" "it crashed (see its terminal): an outage must never kill it"; }

rq() { curl -s -m 10 -u "$RABBIT_USER:$RABBIT_PASS" "$@"; }
queue_field() { rq "$RABBIT/api/queues/%2F/$1" | json "d.get('$2', 0)"; }
# Messages ever published INTO queues whose name starts with $1 (cumulative, so a short-lived retry cannot be missed; updated by RabbitMQ every ~5s).
published_total() { rq "$RABBIT/api/queues" | python3 -c 'import sys,json; p=sys.argv[1]; print(sum((q.get("message_stats") or {}).get("publish",0) for q in json.load(sys.stdin) if q["name"].startswith(p)))' "$1" 2>/dev/null || echo 0; }
dlq_peek() { # up to 20 messages, left on the queue
  rq -X POST -H 'content-type: application/json' "$RABBIT/api/queues/%2F/$CHAT_DLQ/get" -d '{"count":20,"ackmode":"ack_requeue_true","encoding":"auto","truncate":20000}'; }
rabbit_ready() { rq "$RABBIT/api/overview" | json 'd["rabbitmq_version"]'; }
pg_ready() { $DC exec -T chat-db pg_isready -q -U chat -d chat; }
rabbit_ping() { $DC exec -T rabbitmq rabbitmq-diagnostics -q ping; }
wallet_unpublished() { $DC exec -T wallet-db psql -U wallet -d wallet -Atc "select count(*) from event_publication where completion_date is null" 2>/dev/null | tr -d '[:space:]'; }

# A fresh conversation between alice and bob, with alice funded. Sets ALICE BOB ALICE_ID BOB_ID ROOM.
world() {
  ALICE=$(tok alice); BOB=$(tok bob)
  [ -n "$ALICE" ] && [ -n "$BOB" ] || { bad "alice and bob can sign in" "is Keycloak up with the chatpay realm?"; return 1; }
  BOB_ID=$(sub "$BOB")
  call GET "$CHAT/api/me" "$ALICE"; call GET "$CHAT/api/me" "$BOB"
  call POST "$CHAT/api/rooms/direct" "$ALICE" "{\"userId\":\"$BOB_ID\"}"
  ROOM=$(echo "$BODY" | json 'd["id"]')
  [ -n "$ROOM" ] || { bad "a direct room alice-bob exists" "$STATUS $BODY"; return 1; }
  call POST "$WALLET/api/v1/dev/topup" "$ALICE" '{"amountMinor":50000}'
  [ "$STATUS" = 200 ] || { bad "alice can be topped up" "$STATUS $BODY"; return 1; }
}

# alice pays bob 100 in the room. Sets INTENT.
pay() {
  INTENT=""
  call POST "$WALLET/api/v1/transfer-intents" "$ALICE" "{\"toUserId\":\"$BOB_ID\",\"amountMinor\":100,\"note\":\"resilience $RANDOM\",\"reference\":{\"type\":\"chat\",\"id\":\"$ROOM\"}}"
  [ "$STATUS" = 201 ] || { bad "payment intent created" "$STATUS $BODY"; return 1; }
  INTENT=$(echo "$BODY" | json 'd["id"]')
  call POST "$WALLET/api/v1/transfer-intents/$INTENT/confirm" "$ALICE"
  [ "$STATUS" = 200 ] || { bad "payment confirmed" "$STATUS $BODY"; return 1; }
}

bubble_count() {   # payment bubbles for $INTENT as bob sees them in $ROOM, or -1 if the chat cannot answer
  call GET "$CHAT/api/rooms/$ROOM/messages" "$BOB"
  [ "$STATUS" = 200 ] || { echo -1; return; }
  echo "$BODY" | python3 -c 'import sys,json; m=json.load(sys.stdin); print(sum(1 for x in m if x.get("kind")=="payment" and (x.get("payment") or {}).get("intentId")==sys.argv[1]))' "$INTENT" 2>/dev/null || echo -1
}
bubbles_are() { [ "$(bubble_count)" = "$1" ]; }

# ---------------------------------------------------------------- preflight
preflight() {
  echo "Preflight"
  for tool in docker curl python3; do command -v "$tool" >/dev/null || { echo "  FAIL  $tool is required"; return 1; }; done
  local url
  for url in "$KC/.well-known/openid-configuration" "$WALLET/actuator/health" "$CHAT/health"; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url")" = 200 ] || { echo "  FAIL  not reachable: $url  (./scripts/doctor.sh shows what is down)"; return 1; }
  done
  [ -n "$(rabbit_ready)" ] || { echo "  FAIL  RabbitMQ management API not reachable at $RABBIT"; return 1; }
  [ "$(rq "$RABBIT/api/queues/%2F/$CHAT_Q" | json "(d.get('arguments') or {}).get('x-dead-letter-exchange', '')")" = "chat.dlx" ] \
    || { echo "  FAIL  queue $CHAT_Q has no dead-letter exchange: run ./scripts/reset-chat-queues.sh --yes and restart chat-service"; return 1; }
  [ "$(queue_field "$CHAT_Q" consumers)" -ge 1 ] 2>/dev/null || { echo "  FAIL  nobody consumes $CHAT_Q: is chat-service running?"; return 1; }
  [ -n "$($DC ps --services --filter status=running 2>/dev/null | grep -x chat-db)" ] || { echo "  FAIL  '$DC' cannot see a running chat-db: run from the repository root with the stack up"; return 1; }
  echo "  ok    stack is up, the chat queue has dead-lettering and a consumer"
}

# ---------------------------------------------------------------- scenario 1
scenario_chat_db_outage() {
  world || return
  local retries0 dead0; retries0=$(published_total "$CHAT_Q.retry."); dead0=$(published_total "$CHAT_DLQ")

  echo "  stopping chat-db"; quiet $DC stop chat-db
  pay || return
  local a b; a=$(balance "$ALICE"); b=$(balance "$BOB")
  pass "the payment was confirmed while the chat database was down (money does not depend on the chat)"
  sleep 3                                              # let the chat consumer fail at least once and park the event in a retry queue
  still_up "while its database is down"
  [ "$(http_code "$CHAT/ready")" = 503 ] && pass "...and reports itself not ready (/ready is 503), alive but unable to serve" || bad "/ready is 503 while the database is down" "got $(http_code "$CHAT/ready"); an older chat build has no /ready"
  echo "  starting chat-db"; quiet $DC start chat-db
  wait_for 60 pg_ready || { bad "chat-db came back"; return; }

  wait_for 30 eval '[ "$(http_code "$CHAT/ready")" = 200 ]' && pass "chat-service is ready again once the database is back" || bad "chat-service is ready again once the database is back" "/ready is $(http_code "$CHAT/ready")"
  if wait_for 90 bubbles_are 1; then pass "the payment bubble appeared after the database returned"
  else bad "the payment bubble appeared after the database returned" "bubbles: $(bubble_count); dead letters: $(published_total "$CHAT_DLQ") (before: $dead0). If it was dead-lettered the outage outlasted the retry window (~60s): see docs/events.md"; return; fi
  sleep 8
  [ "$(bubble_count)" = 1 ] && pass "...and there is still exactly ONE bubble (no duplicate delivery)" || bad "exactly one bubble" "now $(bubble_count)"
  [ "$(balance "$ALICE")" = "$a" ] && [ "$(balance "$BOB")" = "$b" ] && pass "balances did not change after recovery (the payment was not applied twice)" || bad "balances stable after recovery"

  echo "  waiting for RabbitMQ statistics (they update every ~5s)"; sleep 12
  local retries1 dead1; retries1=$(published_total "$CHAT_Q.retry."); dead1=$(published_total "$CHAT_DLQ")
  [ "$retries1" -gt "$retries0" ] && pass "the event went through a retry queue ($((retries1 - retries0)) retry message(s)): the failure was treated as transient" \
    || bad "the event went through a retry queue" "no retry observed: the consumer may not have failed (is chat-service using the new topology?)"
  [ "$dead1" = "$dead0" ] && pass "nothing was dead-lettered" || bad "nothing was dead-lettered" "dead letters grew from $dead0 to $dead1: see ./scripts/doctor.sh"
}

# ---------------------------------------------------------------- scenario 2
scenario_poison_message() {
  world || return
  if [ "$(dlq_peek | json 'len(d)')" != 0 ]; then skp "poison-message" "$CHAT_DLQ is not empty: look at those dead letters first (this scenario purges the queue when it ends)"; return; fi
  local m1="poison-broken-$RANDOM$RANDOM" m2="poison-wrongtype-$RANDOM$RANDOM"
  local p1 p2
  p1=$(python3 -c 'import json,sys; print(json.dumps({"properties":{"delivery_mode":2,"content_type":"application/json"},"routing_key":"chat.wallet-events","payload":"{\"marker\":\"%s\", this is not json" % sys.argv[1],"payload_encoding":"string"}))' "$m1")
  p2=$(python3 -c 'import json,sys; print(json.dumps({"properties":{"delivery_mode":2,"content_type":"application/json"},"routing_key":"chat.wallet-events","payload":json.dumps({"marker":sys.argv[1],"transferId":42,"amountMinor":"lots"}),"payload_encoding":"string"}))' "$m2")
  # Straight into the chat's own queue (default exchange), so the store's consumer never sees them.
  [ "$(rq -X POST -H 'content-type: application/json' "$RABBIT/api/exchanges/%2F/amq.default/publish" -d "$p1" | json 'd.get("routed")')" = True ] || { bad "junk message 1 was queued"; return; }
  [ "$(rq -X POST -H 'content-type: application/json' "$RABBIT/api/exchanges/%2F/amq.default/publish" -d "$p2" | json 'd.get("routed")')" = True ] || { bad "junk message 2 was queued"; return; }

  have_both() { dlq_peek | python3 -c 'import sys,json; t=" ".join(m["payload"] for m in json.load(sys.stdin)); sys.exit(0 if sys.argv[1] in t and sys.argv[2] in t else 1)' "$m1" "$m2"; }
  if wait_for 30 have_both; then pass "both junk messages reached $CHAT_DLQ"; else bad "both junk messages reached $CHAT_DLQ" "see ./scripts/doctor.sh; is chat-service running the new consumer?"; rq -X DELETE "$RABBIT/api/queues/%2F/$CHAT_DLQ/contents" >/dev/null; return; fi

  dlq_peek | python3 -c '
import sys, json
for m in json.load(sys.stdin):
    h = m["properties"].get("headers", {})
    marker = "broken" if "poison-broken" in m["payload"] else "wrongtype" if "poison-wrongtype" in m["payload"] else None
    if marker is None: continue
    ok = h.get("x-failure-kind") == "permanent" and h.get("x-retry-count") == 0 and h.get("x-original-queue") == "chat.wallet-events" and h.get("x-error-class") in ("SyntaxError", "ZodError") and h.get("x-error")
    print(("ok   " if ok else "FAIL ") + marker + ": kind=%s retries=%s class=%s" % (h.get("x-failure-kind"), h.get("x-retry-count"), h.get("x-error-class")))
' > /tmp/e2e-res.verdicts
  while IFS= read -r line; do case $line in ok*) pass "dead-lettered at once, never retried: ${line#ok   }";; *) bad "${line#FAIL }";; esac; done < /tmp/e2e-res.verdicts

  pay || { rq -X DELETE "$RABBIT/api/queues/%2F/$CHAT_DLQ/contents" >/dev/null; return; }
  wait_for 45 bubbles_are 1 && pass "a normal payment right after the junk is delivered (the queue was not blocked)" || bad "a normal payment right after the junk is delivered" "bubbles: $(bubble_count)"
  sleep 6; [ "$(bubble_count)" = 1 ] && pass "...exactly once" || bad "exactly one bubble" "now $(bubble_count)"
  rq -X DELETE "$RABBIT/api/queues/%2F/$CHAT_DLQ/contents" >/dev/null && echo "  (removed the two junk dead letters)"
  still_up "after the junk messages"
}

# ---------------------------------------------------------------- scenario 3
scenario_broker_outage() {
  world || return
  local outbox0; outbox0=$(wallet_unpublished)
  echo "  stopping rabbitmq"; quiet $DC stop rabbitmq
  pay || return
  pass "the payment was confirmed while RabbitMQ was down (the wallet does not need the broker to move money)"
  sleep 3; still_up "while RabbitMQ is down"
  local outbox1; outbox1=$(wallet_unpublished)
  if [ -n "$outbox0" ] && [ -n "$outbox1" ]; then
    [ "$outbox1" -gt "$outbox0" ] && pass "the event is safe in the wallet's outbox ($outbox0 -> $outbox1 unpublished)" || bad "the event is stored in the wallet's outbox" "unpublished events: $outbox0 -> $outbox1"
  else skp "outbox check" "cannot query wallet-db with '$DC exec'"; fi

  echo "  starting rabbitmq"; quiet $DC start rabbitmq
  wait_for 90 rabbit_ping || { bad "rabbitmq came back"; return; }
  wait_for 60 rabbit_ready || { bad "the RabbitMQ management API came back"; return; }
  consumer_back() { [ "$(queue_field "$CHAT_Q" consumers)" -ge 1 ] 2>/dev/null; }
  wait_for 90 consumer_back && pass "chat-service reconnected and is consuming again" || bad "chat-service reconnected" "it retries every 5s: is the process still running?"

  echo "  waiting for the wallet to republish its stored event (its timer runs every 30s)"
  if wait_for 150 bubbles_are 1; then
    pass "the payment bubble appeared after the broker returned (the wallet republished the stored event)"
    sleep 8; [ "$(bubble_count)" = 1 ] && pass "...exactly once" || bad "exactly one bubble" "now $(bubble_count)"
  else
    local still; still=$(wallet_unpublished)
    bad "the payment bubble appeared after the broker returned" "wallet outbox still holds $still unpublished event(s) (was $outbox1): is the wallet running a build with OutboxSweeper (wallet.event-republish-*)? An older wallet only republishes when it restarts."
  fi
  store_consumer_back() { [ "$(queue_field "$STORE_Q" consumers)" -ge 1 ] 2>/dev/null; }
  wait_for 90 store_consumer_back && pass "the store's events:consume is consuming again (it reconnects by itself)" \
    || bad "the store's events:consume is consuming again" "an older build exits when RabbitMQ goes away: restart it (php artisan events:consume or ./dev.sh)"
}

# ---------------------------------------------------------------- run
preflight || { echo; echo "Preflight failed: nothing was touched."; trap - EXIT; exit 2; }
for s in "${SELECTED[@]}"; do
  echo; echo "Scenario: $s"; echo "  $(describe "$s")"
  case $s in
    chat-db-outage) scenario_chat_db_outage ;;
    poison-message) scenario_poison_message ;;
    broker-outage)  scenario_broker_outage ;;
  esac
done

echo; echo "$ok ok, $fail failed, $skip skipped"
[ "$fail" = 0 ]
