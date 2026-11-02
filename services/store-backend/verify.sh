#!/usr/bin/env bash
# Smoke test of a RUNNING store backend (php artisan serve / ./dev.sh) and, when they are up, Keycloak and the wallet.
# Prints a line per check (with the HTTP status it got when that is not what was expected) and exits non-zero if any check failed.
#   BASE=... KC=... WALLET=... ./verify.sh
BASE=${BASE:-http://localhost:8000}
KC=${KC:-http://localhost:8080/realms/chatpay}
WALLET=${WALLET:-http://localhost:8081}
ok=0; fail=0; skip=0
pass() { echo "  ok    $1"; ok=$((ok+1)); }
bad()  { echo "  FAIL  $1${2:+  ($2)}"; fail=$((fail+1)); }
skp()  { echo "  skip  $1${2:+  ($2)}"; skip=$((skip+1)); }
code() { curl -s -o /dev/null -w '%{http_code}' -m 10 "$@"; }
json() { python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null; }
# expect_code <status> <description> <curl args...>
expect_code() {
  local want=$1 name=$2; shift 2
  local got; got=$(code "$@")
  if [ "$got" = "$want" ]; then pass "$name"; else
    local hint=""; [ "$got" = 429 ] && hint=", rate limited: run 'php artisan cache:clear' or wait"
    bad "$name" "expected HTTP $want, got $got$hint"
  fi
}

echo "Store backend at $BASE"
[ "$(code "$BASE/up")" = 200 ] && pass "health endpoint (/up)" || { bad "health endpoint (/up)" "is ./dev.sh (or 'php artisan serve --port=8000') running?"; echo "$ok ok, $fail failed"; exit 1; }

products=$(curl -s -m 10 "$BASE/api/v1/products")
echo "$products" | grep -q 'ceramic-mug' && pass "catalog lists the demo products" || bad "catalog lists the demo products" "did 'store:seed-demo' run?"
[ "$(curl -s -m 10 "$BASE/api/v1/products/hot" | json 'len(d)')" -ge 1 ] 2>/dev/null && pass "hot products" || bad "hot products"
expect_code 404 "unknown product is a 404" "$BASE/api/v1/products/does-not-exist"
expect_code 401 "ordering without a login is refused" -X POST "$BASE/api/v1/orders" -H 'Content-Type: application/json' -d '{}'
expect_code 401 "applying for a store without a login is refused" -X POST "$BASE/api/v1/stores" -H 'Content-Type: application/json' -d '{"name":"Anon"}'
curl -sL -c /tmp/store-verify.jar -b /tmp/store-verify.jar -o /dev/null -w '%{url_effective}' -m 15 "$BASE/admin" | grep -q 'openid-connect/auth' \
  && pass "/admin sends you to Keycloak to sign in" || bad "/admin sends you to Keycloak to sign in" "is Keycloak up at $KC ?"

echo "Keycloak token from a real login (alice)"
token=$(curl -s -m 10 -d client_id=chatpay-web -d grant_type=password -d username=alice -d password=password "$KC/protocol/openid-connect/token" | json 'd["access_token"]')
if [ -z "$token" ]; then skp "authenticated checks" "could not get a token from Keycloak"; else
  pass "alice can sign in at Keycloak"
  expect_code 200 "the store API accepts a real Keycloak token" -H "Authorization: Bearer $token" "$BASE/api/v1/orders"
  expect_code 401 "a tampered token is refused" -H "Authorization: Bearer ${token}x" "$BASE/api/v1/orders"
  expect_code 200 "GET /me/store" -H "Authorization: Bearer $token" "$BASE/api/v1/me/store"

  echo "Checkout (needs the wallet at $WALLET)"
  if [ "$(code "$WALLET/actuator/health")" != 200 ]; then skp "checkout and payment" "wallet is not running"; else
    pid=$(echo "$products" | json 'd["items"][0]["id"]')
    order=$(curl -s -m 15 -X POST "$BASE/api/v1/orders" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"items\":[{\"productId\":$pid,\"quantity\":1}]}")
    intent=$(echo "$order" | json 'd["payment"]["intentId"]')
    [ -n "$intent" ] && pass "checkout created an order and a wallet payment ($intent)" || bad "checkout created an order and a wallet payment" "$(echo "$order" | head -c 200)"
    if [ -n "$intent" ]; then
      oid=$(echo "$order" | json 'd["id"]')
      curl -s -m 10 -X POST "$WALLET/api/v1/dev/topup" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"amountMinor":100000}' >/dev/null
      expect_code 200 "alice confirmed the payment in the wallet" -X POST "$WALLET/api/v1/transfer-intents/$intent/confirm" -H "Authorization: Bearer $token"
      st=""; for i in 1 2 3 4 5 6 7 8 9 10; do st=$(curl -s -m 10 "$BASE/api/v1/orders/$oid" -H "Authorization: Bearer $token" | json 'd["status"]'); [ "$st" = paid ] && break; sleep 1; done
      [ "$st" = paid ] && pass "the order became 'paid' (events:consume is working)" || bad "the order became 'paid'" "status is '$st': are 'events:consume' and RabbitMQ running?"
    fi
  fi
fi

echo; echo "$ok ok, $fail failed, $skip skipped"; [ "$fail" = 0 ]
