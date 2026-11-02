#!/usr/bin/env bash
# End-to-end check across the WHOLE stack, driven through the real APIs (no UI needed):
#   Keycloak sign-in -> wallet top-up -> chat room -> person-to-person payment (+ chat bubble) -> insufficient funds ->
#   gift order from the store (+ order paid + gift bubble) -> finance reversal with two people.
# Needs everything running: docker compose up -d, wallet-service, chat-service, store-backend (./dev.sh, which includes
# events:consume and outbox:relay). Run ./scripts/doctor.sh first if anything fails. Safe to re-run (it checks changes, not absolutes).
#   KC=... WALLET=... CHAT=... STORE=... ./scripts/e2e.sh
KC=${KC:-http://localhost:8080/realms/chatpay}
WALLET=${WALLET:-http://localhost:8081}
CHAT=${CHAT:-http://localhost:4000}
STORE=${STORE:-http://localhost:8000}
ok=0; fail=0; skip=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
bad()  { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail+1)); }
skp()  { echo "  skip  $1${2:+  ($2)}"; skip=$((skip+1)); }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
jq_()  { echo "$BODY" | json "$1"; }                       # evaluate an expression on the last response body (as d)

tok() { curl -s -m 10 -d client_id=chatpay-web -d grant_type=password -d username="$1" -d password=password "$KC/protocol/openid-connect/token" | json 'd["access_token"]'; }
sub() { python3 -c 'import sys,json,base64; p=sys.argv[1].split(".")[1]; p+="="*(-len(p)%4); print(json.loads(base64.urlsafe_b64decode(p))["sub"])' "$1" 2>/dev/null; }

# call METHOD URL TOKEN [JSON]  ->  sets STATUS and BODY
call() {
  local method=$1 url=$2 token=$3 body=${4:-}
  local args=(-s -m 20 -o /tmp/e2e.body -w '%{http_code}' -X "$method" "$url")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  STATUS=$(curl "${args[@]}"); BODY=$(cat /tmp/e2e.body)
}
balance() { call GET "$WALLET/api/v1/wallet" "$1"; jq_ 'd["balanceMinor"]'; }
# expect <status> <description> [hint]   (uses STATUS from the last call)
expect() { if [ "$STATUS" = "$1" ]; then pass "$2"; else bad "$2" "expected HTTP $1, got $STATUS: $(echo "$BODY" | head -c 160)${3:+ | $3}"; fi; }
same() { if [ "$1" = "$2" ]; then pass "$3"; else bad "$3" "expected $2, got ${1:-nothing}${4:+ | $4}"; fi; }
wait_for() { local secs=$1; shift; local i; for ((i=0; i<secs; i++)); do "$@" && return 0; sleep 1; done; return 1; }

echo "0. Is everything there?"
for u in "$KC/.well-known/openid-configuration" "$WALLET/actuator/health" "$CHAT/health" "$STORE/up"; do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$u")" = 200 ] || { echo "  FAIL  not reachable: $u"; echo "Run ./scripts/doctor.sh to see what is down."; exit 2; }
done; pass "Keycloak, wallet, chat and store all answer"

echo "1. Sign in with Keycloak"
ALICE=$(tok alice); BOB=$(tok bob); F1=$(tok finance1); F2=$(tok finance2)
[ -n "$ALICE" ] && [ -n "$BOB" ] || { bad "alice and bob can sign in" "check the realm import and that Keycloak runs at $KC"; exit 1; }
pass "alice and bob signed in"; [ -n "$F1" ] && [ -n "$F2" ] && pass "finance1 and finance2 signed in" \
  || bad "finance users can sign in" "Keycloak still has an OLD realm: recreate it with 'docker compose rm -sf keycloak && docker compose up -d keycloak' (the import only runs for a realm that does not exist yet)"
ALICE_ID=$(sub "$ALICE"); BOB_ID=$(sub "$BOB")

echo "2. Wallet: top-up"
a0=$(balance "$ALICE"); b0=$(balance "$BOB")
call POST "$WALLET/api/v1/dev/topup" "$ALICE" '{"amountMinor":100000}'; expect 200 "top-up accepted (dev profile)"
a1=$(balance "$ALICE"); same $((a1 - a0)) 100000 "alice's balance rose by exactly 100000" 

echo "3. Chat: a 1:1 room"
call GET "$CHAT/api/me" "$ALICE"; call GET "$CHAT/api/me" "$BOB"
call POST "$CHAT/api/rooms/direct" "$ALICE" "{\"userId\":\"$BOB_ID\"}"; expect 200 "alice opened a direct room with bob"
ROOM=$(jq_ 'd["id"]')

echo "4. Person-to-person payment (wallet -> RabbitMQ -> chat bubble)"
call POST "$WALLET/api/v1/transfer-intents" "$ALICE" "{\"toUserId\":\"$BOB_ID\",\"amountMinor\":2500,\"note\":\"e2e lunch\",\"reference\":{\"type\":\"chat\",\"id\":\"$ROOM\"}}"
expect 201 "payment intent created (nothing moved yet)"; INTENT=$(jq_ 'd["id"]')
same "$(balance "$ALICE")" "$a1" "balance unchanged before confirming"
call POST "$WALLET/api/v1/transfer-intents/$INTENT/confirm" "$ALICE"; expect 200 "alice confirmed the payment"
a2=$(balance "$ALICE"); b1=$(balance "$BOB")
same "$a2" $((a1 - 2500)) "alice paid 2500"; same "$b1" $((b0 + 2500)) "bob received 2500"
call POST "$WALLET/api/v1/transfer-intents/$INTENT/confirm" "$ALICE"; expect 200 "confirming again returns the same result"
same "$(balance "$ALICE")" "$a2" "...and does not charge twice"
has_payment() { call GET "$CHAT/api/rooms/$ROOM/messages" "$BOB"; echo "$BODY" | python3 -c 'import sys,json; m=json.load(sys.stdin); sys.exit(0 if any(x.get("kind")=="payment" and (x.get("payment") or {}).get("intentId")==sys.argv[1] for x in m) else 1)' "$INTENT" 2>/dev/null; }
wait_for 20 has_payment && pass "bob's chat shows the payment bubble (events flow wallet -> chat)" \
  || bad "bob's chat shows the payment bubble" "run ./scripts/doctor.sh: is chat-service consuming chat.wallet-events? any unpublished wallet events?"
call GET "$CHAT/api/rooms" "$BOB"; same "$(echo "$BODY" | python3 -c 'import sys,json; r=[x for x in json.load(sys.stdin) if x["id"]==sys.argv[1]]; print(r[0]["unreadCount"] >= 1)' "$ROOM" 2>/dev/null)" True "the payment counts as unread for bob"

echo "5. Not enough money"
call POST "$WALLET/api/v1/transfer-intents" "$BOB" "{\"toUserId\":\"$ALICE_ID\",\"amountMinor\":900000000}"; BIG=$(jq_ 'd["id"]')
call POST "$WALLET/api/v1/transfer-intents/$BIG/confirm" "$BOB"; expect 422 "confirm is refused for insufficient funds"
same "$(jq_ 'd["code"]')" INSUFFICIENT_FUNDS "...with the right error code"
call POST "$WALLET/api/v1/transfer-intents/$BIG/cancel" "$BOB"; expect 200 "the unpaid payment can be cancelled"

echo "6. Store: a gift order for bob, bought 'from the chat'"
PRODUCT=$(curl -s -m 10 "$STORE/api/v1/products" | json 'd["items"][0]["id"]')
[ -n "$PRODUCT" ] || { bad "the catalog has a product" "did 'php artisan store:seed-demo' run?"; PRODUCT=0; }
call POST "$STORE/api/v1/orders" "$ALICE" "{\"items\":[{\"productId\":$PRODUCT,\"quantity\":1}],\"giftFor\":\"$BOB_ID\",\"context\":{\"type\":\"chat\",\"roomId\":\"$ROOM\"}}"
expect 201 "order created, priced by the store" "is the store backend allowed to call the wallet? role wallet-merchant on client laravel-service"
ORDER=$(jq_ 'd["id"]'); OINTENT=$(jq_ 'd["payment"]["intentId"]'); TOTAL=$(jq_ 'd["totalMinor"]')
call POST "$WALLET/api/v1/transfer-intents/$OINTENT/confirm" "$ALICE"; expect 200 "alice paid for the order in the wallet"
same "$(balance "$ALICE")" $((a2 - TOTAL)) "alice was charged exactly the order total ($TOTAL), into escrow"
order_paid() { call GET "$STORE/api/v1/orders/$ORDER" "$ALICE"; [ "$(jq_ 'd["status"]')" = paid ]; }
wait_for 20 order_paid && pass "the order became 'paid' (wallet event -> store events:consume)" \
  || bad "the order became 'paid'" "is 'events:consume' running? see ./scripts/doctor.sh (queue store.wallet-events, dead letters)"
has_order() { call GET "$CHAT/api/rooms/$ROOM/messages" "$BOB"; echo "$BODY" | python3 -c 'import sys,json; m=json.load(sys.stdin); sys.exit(0 if any(x.get("kind")=="order" and (x.get("order") or {}).get("orderId")==sys.argv[1] for x in m) else 1)' "$ORDER" 2>/dev/null; }
wait_for 25 has_order && pass "bob's chat shows the gift-order bubble (store outbox -> RabbitMQ -> chat)" \
  || bad "bob's chat shows the gift-order bubble" "is 'outbox:relay' running? unpublished store events? is chat consuming chat.store-events?"

echo "7. Finance: a correction needs two different people"
call GET "$WALLET/api/v1/transfers?limit=50" "$ALICE"
TID=$(echo "$BODY" | python3 -c 'import sys,json; t=[x for x in json.load(sys.stdin) if x.get("intentId")==sys.argv[1]]; print(t[0]["id"] if t else "")' "$INTENT" 2>/dev/null)
[ -n "$TID" ] && pass "found the transfer for the lunch payment" || bad "found the transfer for the lunch payment"
call POST "$WALLET/api/v1/admin/transfers/$TID/reversal" "$F1" '{"reasonCode":"E2E","reason":"end-to-end test"}'; expect 201 "finance1 requested a reversal (nothing moved yet)"
ACTION=$(jq_ 'd["id"]')
call POST "$WALLET/api/v1/admin/actions/$ACTION/approve" "$F1"; expect 403 "finance1 cannot approve their own request"; same "$(jq_ 'd["code"]')" FOUR_EYES "...it says FOUR_EYES"
call POST "$WALLET/api/v1/admin/actions/$ACTION/approve" "$F2" '{"note":"ok"}'; expect 200 "finance2 approved it"
same "$(balance "$BOB")" "$b0" "bob is back where he started (the money was returned by NEW entries)"
call GET "$WALLET/api/v1/admin/reconciliation" "$F2"; same "$(jq_ 'len(d)')" 0 "books reconcile: every balance matches its ledger entries"
call GET "$WALLET/api/v1/wallet/entries?limit=10" "$ALICE"
same "$(echo "$BODY" | python3 -c 'import sys,json; print(any(e["kind"]=="REVERSAL" for e in json.load(sys.stdin)["items"]))' 2>/dev/null)" True "alice's statement shows the REVERSAL entry"

echo "8. History cannot be edited"
if docker compose exec -T wallet-db psql -U wallet -d wallet -c "update ledger_entry set amount_minor = 1" 2>&1 | grep -qi "append-only"; then pass "the database refuses to edit ledger entries"
else skp "the database refuses to edit ledger entries" "needs 'docker compose' in the current directory"; fi

echo; echo "$ok ok, $fail failed, $skip skipped"; [ "$fail" = 0 ]
