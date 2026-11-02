"""
Tests for mock-services/stack (the Keycloak + wallet + chat + store stub used by scripts/e2e.sh and verify.sh).
They drive MockStack.handle() directly: no sockets, no threads. They pin the behaviours the scripts rely on, so a change to the
stub that would silently break e2e.sh or verify.sh fails here first.
Run with: make test-mocks
"""
import importlib.util
import json
import unittest
from pathlib import Path
from urllib.parse import urlencode

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("mock_stack_server", ROOT / "mock-services" / "stack" / "server.py")
stack_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack_mod)


class Api:
    """A tiny client around MockStack.handle, shaped like the curl calls in the scripts."""

    def __init__(self):
        self.stack = stack_mod.MockStack()

    def call(self, method, path, user=None, body=None, form=None, token=None, host="127.0.0.1:9977"):
        headers = {"Host": host}
        raw = b""
        if form is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            raw = urlencode(form).encode()
        elif body is not None:
            headers["Content-Type"] = "application/json"
            raw = json.dumps(body).encode()
        if token or user:
            headers["Authorization"] = "Bearer " + (token or stack_mod.make_token(user))
        status, payload, extra = self.stack.handle(method, path, headers, raw)
        return status, payload, extra

    def login(self, user):
        return self.call("POST", "/realms/chatpay/protocol/openid-connect/token", form={"username": user, "password": "password", "grant_type": "password", "client_id": "chatpay-web"})[1]["access_token"]

    def balance(self, user):
        return self.call("GET", "/api/v1/wallet", user)[1]["balanceMinor"]


def sub(user):
    return "id-" + user


class TokenTests(unittest.TestCase):
    def setUp(self):
        self.api = Api()

    def test_login_gives_a_token_the_other_endpoints_accept(self):
        token = self.api.login("alice")
        status, body, _ = self.api.call("GET", "/api/me", token=token)
        self.assertEqual((status, body["id"]), (200, "id-alice"))

    def test_a_tampered_or_malformed_token_is_refused(self):
        token = self.api.login("alice")
        for bad in (token + "x", token[:-1] + "z", "garbage", token.rsplit(".", 1)[0], "a.b"):
            self.assertEqual(self.api.call("GET", "/api/me", token=bad)[0], 401, bad)
        self.assertEqual(self.api.call("GET", "/api/me")[0], 401)

    def test_login_without_a_username_is_a_400(self):
        self.assertEqual(self.api.call("POST", "/realms/chatpay/protocol/openid-connect/token", form={"password": "x"})[0], 400)

    def test_doctor_style_probes(self):
        self.assertEqual(self.api.call("GET", "/realms/chatpay")[1]["realm"], "chatpay")
        self.assertEqual(self.api.call("GET", "/realms/chatpay/.well-known/openid-configuration")[1]["issuer"], "http://localhost:8080/realms/chatpay")
        self.assertEqual(self.api.call("GET", "/actuator/health")[1], {"status": "UP"})
        self.assertEqual(self.api.call("GET", "/health")[1], {"status": "ok"})
        self.assertEqual(self.api.call("GET", "/up")[0], 200)


class PaymentFlowTests(unittest.TestCase):
    """The same steps as scripts/e2e.sh sections 2-5."""

    def setUp(self):
        self.api = Api()
        self.api.call("POST", "/api/v1/dev/topup", "alice", {"amountMinor": 100000})
        self.room = self.api.call("POST", "/api/rooms/direct", "alice", {"userId": sub("bob")})[1]["id"]

    def pay(self, amount=2500, note="lunch"):
        _, intent, _ = self.api.call("POST", "/api/v1/transfer-intents", "alice",
                                     {"toUserId": sub("bob"), "amountMinor": amount, "note": note, "reference": {"type": "chat", "id": self.room}})
        return intent["id"]

    def test_creating_an_intent_moves_nothing_and_confirming_moves_money_once(self):
        intent = self.pay()
        self.assertEqual(self.api.balance("alice"), 100000)
        self.assertEqual(self.api.call("POST", f"/api/v1/transfer-intents/{intent}/confirm", "alice")[0], 200)
        self.assertEqual((self.api.balance("alice"), self.api.balance("bob")), (97500, 2500))
        self.assertEqual(self.api.call("POST", f"/api/v1/transfer-intents/{intent}/confirm", "alice")[0], 200)     # idempotent
        self.assertEqual((self.api.balance("alice"), self.api.balance("bob")), (97500, 2500))

    def test_only_the_payer_can_confirm(self):
        intent = self.pay()
        self.assertEqual(self.api.call("POST", f"/api/v1/transfer-intents/{intent}/confirm", "bob")[0], 404)

    def test_confirming_produces_a_payment_bubble_and_an_unread_count_for_the_recipient(self):
        intent = self.pay()
        self.api.call("POST", f"/api/v1/transfer-intents/{intent}/confirm", "alice")
        messages = self.api.call("GET", f"/api/rooms/{self.room}/messages", "bob")[1]
        self.assertTrue(any(m["kind"] == "payment" and m["payment"]["intentId"] == intent for m in messages))
        self.assertGreaterEqual(self.api.call("GET", "/api/rooms", "bob")[1][0]["unreadCount"], 1)

    def test_insufficient_funds_changes_nothing_and_the_intent_can_be_cancelled(self):
        _, intent, _ = self.api.call("POST", "/api/v1/transfer-intents", "bob", {"toUserId": sub("alice"), "amountMinor": 900000000})
        status, body, _ = self.api.call("POST", f"/api/v1/transfer-intents/{intent['id']}/confirm", "bob")
        self.assertEqual((status, body["code"]), (422, "INSUFFICIENT_FUNDS"))
        self.assertEqual(self.api.balance("bob"), 0)
        self.assertEqual(self.api.call("POST", f"/api/v1/transfer-intents/{intent['id']}/cancel", "bob")[0], 200)

    def test_four_eyes_on_a_reversal(self):
        intent = self.pay()
        self.api.call("POST", f"/api/v1/transfer-intents/{intent}/confirm", "alice")
        transfer = self.api.call("GET", "/api/v1/transfers", "alice")[1][0]
        self.assertEqual(transfer["intentId"], intent)
        action = self.api.call("POST", f"/api/v1/admin/transfers/{transfer['id']}/reversal", "finance1", {"reasonCode": "E2E"})[1]["id"]
        status, body, _ = self.api.call("POST", f"/api/v1/admin/actions/{action}/approve", "finance1")
        self.assertEqual((status, body["code"]), (403, "FOUR_EYES"))
        self.assertEqual(self.api.call("POST", f"/api/v1/admin/actions/{action}/approve", "finance2")[0], 200)
        self.assertEqual((self.api.balance("alice"), self.api.balance("bob")), (100000, 0))
        self.assertEqual(self.api.call("GET", "/api/v1/admin/reconciliation", "finance2")[1], [])
        entries = self.api.call("GET", "/api/v1/wallet/entries", "alice")[1]["items"]
        self.assertTrue(any(e["kind"] == "REVERSAL" for e in entries))


class StoreFlowTests(unittest.TestCase):
    """The same steps as scripts/e2e.sh section 6 and services/store-backend/verify.sh."""

    def setUp(self):
        self.api = Api()

    def test_catalog_endpoints_used_by_verify_sh(self):
        status, body, _ = self.api.call("GET", "/api/v1/products")
        self.assertTrue(any(p["slug"] == "ceramic-mug" for p in body["items"]))
        self.assertGreaterEqual(len(self.api.call("GET", "/api/v1/products/hot")[1]), 1)
        self.assertEqual(self.api.call("GET", "/api/v1/products/ceramic-mug")[0], 200)
        self.assertEqual(self.api.call("GET", "/api/v1/products/does-not-exist")[0], 404)

    def test_login_is_required_to_order_or_apply(self):
        self.assertEqual(self.api.call("POST", "/api/v1/orders", body={})[0], 401)
        self.assertEqual(self.api.call("POST", "/api/v1/stores", body={"name": "Anon"})[0], 401)
        self.assertEqual(self.api.call("GET", "/api/v1/orders")[0], 401)
        self.assertEqual(self.api.call("GET", "/api/v1/me/store")[0], 401)

    def test_admin_redirects_to_keycloak_on_the_same_host(self):
        status, _, extra = self.api.call("GET", "/admin", host="localhost:9977")
        self.assertEqual(status, 302)
        self.assertTrue(extra["Location"].startswith("http://localhost:9977/realms/chatpay/protocol/openid-connect/auth"))
        self.assertEqual(self.api.call("GET", "/realms/chatpay/protocol/openid-connect/auth")[0], 200)

    def test_applying_for_a_store(self):
        self.assertIsNone(self.api.call("GET", "/api/v1/me/store", "carol")[1]["store"])
        self.assertEqual(self.api.call("POST", "/api/v1/stores", "carol", {"name": "Carol Crafts"})[0], 201)
        self.assertEqual(self.api.call("GET", "/api/v1/me/store", "carol")[1]["store"]["status"], "pending")
        self.assertEqual(self.api.call("POST", "/api/v1/stores", "carol", {"name": "Again"})[0], 409)

    def test_gift_order_is_priced_by_the_store_paid_in_the_wallet_and_bubbles_into_the_chat(self):
        self.api.call("POST", "/api/v1/dev/topup", "alice", {"amountMinor": 100000})
        room = self.api.call("POST", "/api/rooms/direct", "alice", {"userId": sub("bob")})[1]["id"]
        product = self.api.call("GET", "/api/v1/products")[1]["items"][0]

        status, order, _ = self.api.call("POST", "/api/v1/orders", "alice", {
            "items": [{"productId": product["id"], "quantity": 2, "priceMinor": 1}], "giftFor": sub("bob"), "context": {"type": "chat", "roomId": room}})
        self.assertEqual(status, 201)
        self.assertEqual(order["totalMinor"], product["priceMinor"] * 2)           # the client's own price is ignored
        self.assertEqual(self.api.call("GET", f"/api/v1/orders/{order['id']}", "alice")[1]["status"], "pending_payment")

        self.assertEqual(self.api.call("POST", f"/api/v1/transfer-intents/{order['payment']['intentId']}/confirm", "alice")[0], 200)
        self.assertEqual(self.api.balance("alice"), 100000 - order["totalMinor"])
        self.assertEqual(self.api.call("GET", f"/api/v1/orders/{order['id']}", "alice")[1]["status"], "paid")
        messages = self.api.call("GET", f"/api/rooms/{room}/messages", "bob")[1]
        self.assertTrue(any(m["kind"] == "order" and m["order"]["orderId"] == order["id"] for m in messages))

    def test_unknown_products_are_refused(self):
        self.assertEqual(self.api.call("POST", "/api/v1/orders", "alice", {"items": [{"productId": 99999, "quantity": 1}]})[0], 422)

    def test_unknown_routes_are_404(self):
        self.assertEqual(self.api.call("GET", "/nope")[0], 404)
        self.assertEqual(self.api.call("GET", "/api/rooms/missing/messages", "alice")[0], 404)


if __name__ == "__main__":
    unittest.main()
