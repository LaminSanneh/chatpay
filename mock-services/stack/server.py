#!/usr/bin/env python3
"""
Permanent stub of the HTTP surface of the whole stack, so scripts/e2e.sh and services/store-backend/verify.sh can be
exercised WITHOUT Keycloak, the wallet, the chat or the store being installed or running.

It stands in for (see docs/events.md for the real contracts):
  Keycloak       GET  /realms/chatpay, /.well-known/openid-configuration, /protocol/openid-connect/auth; POST .../token (password grant)
  wallet         /actuator/health, /api/v1/wallet, dev/topup, transfer-intents (+confirm, cancel), transfers, wallet/entries, admin reversal/approve/reconciliation
  chat-service   /health, /api/me, /api/rooms, /api/rooms/direct, /api/rooms/:id/messages
  store-backend  /up, /admin (redirects to Keycloak), /api/v1/products(+hot, :slug), stores, me/store, orders(+:id)
It keeps state in memory (balances, intents, messages, orders) and applies the same rules the real services do that the scripts rely on:
idempotent confirm, INSUFFICIENT_FUNDS, four-eyes on admin approval, and tokens that fail when tampered with.
It is NOT a model of the real services; it only makes the scripts testable. Data lives in catalog.json.

Run it in the FOREGROUND in its own terminal (stop with Ctrl-C), or use `make mock-stack`:
    python3 mock-services/stack/server.py [--port 9977] [--catalog mock-services/stack/catalog.json]
`MockStack.handle()` is a pure function of (method, path, headers, body): no sockets, so the unit tests call it directly.
"""
import argparse
import base64
import json
import re
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
DEFAULT_CATALOG = HERE / "catalog.json"
REALM = "/realms/chatpay"
SIGNATURE = "y"       # the only signature this stub accepts: any other (a tampered token) is refused, like a real JWT check


def _b64(d):
    return base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")


def make_token(username):
    """header.payload.signature, shaped like a JWT. Only the payload's `sub` and the fixed signature matter."""
    return f"h.{_b64({'sub': 'id-' + username, 'preferred_username': username})}.{SIGNATURE}"


def user_from(auth_header):
    """The caller's `sub`, or None when the Authorization header is missing, malformed or tampered with."""
    if not auth_header or not auth_header.startswith("Bearer "):
        return None
    parts = auth_header[7:].split(".")
    if len(parts) != 3 or parts[2] != SIGNATURE:
        return None
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))["sub"]
    except Exception:
        return None


class MockStack:
    def __init__(self, catalog_path=DEFAULT_CATALOG):
        self.catalog = json.loads(Path(catalog_path).read_text())["products"]
        self.reset()

    def reset(self):
        self.balances, self.intents, self.transfers, self.rooms = {}, {}, [], {}
        self.orders, self.actions, self.reversed, self.stores = {}, {}, set(), {}

    # ------------------------------------------------------------------ entry point
    def handle(self, method, target, headers, body=b""):
        """Returns (status, json_body_or_None, extra_headers)."""
        url = urlparse(target)
        path = url.path
        me = user_from(headers.get("Authorization"))
        data = self._parse(headers, body)
        try:
            for route in (self._keycloak, self._health, self._wallet, self._admin, self._chat, self._store):
                result = route(method, path, me, data, headers)
                if result is not None:
                    return result[0], result[1], (result[2] if len(result) > 2 else {})
        except KeyError:
            return 404, {"code": "NOT_FOUND", "path": path}, {}
        return 404, {"code": "NOT_FOUND", "path": path}, {}

    @staticmethod
    def _parse(headers, body):
        if not body:
            return {}
        raw = body.decode()
        if "x-www-form-urlencoded" in (headers.get("Content-Type") or ""):
            return {k: v[0] for k, v in parse_qs(raw).items()}
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    def _bal(self, user):
        return self.balances.setdefault(user, 0)

    # ------------------------------------------------------------------ Keycloak
    def _keycloak(self, method, path, me, data, headers):
        if path == REALM and method == "GET":
            return 200, {"realm": "chatpay"}
        if path == REALM + "/.well-known/openid-configuration":
            return 200, {"issuer": "http://localhost:8080/realms/chatpay"}
        if path == REALM + "/protocol/openid-connect/auth":
            return 200, {"login": "stub"}
        if path == REALM + "/protocol/openid-connect/token" and method == "POST":
            if not data.get("username"):
                return 400, {"error": "invalid_request"}
            return 200, {"access_token": make_token(data["username"]), "expires_in": 900}
        return None

    def _health(self, method, path, me, data, headers):
        return {"/actuator/health": (200, {"status": "UP"}), "/health": (200, {"status": "ok"}), "/up": (200, {})}.get(path)

    # ------------------------------------------------------------------ wallet
    def _wallet(self, method, path, me, data, headers):
        if not path.startswith("/api/v1/") or path.startswith(("/api/v1/products", "/api/v1/orders", "/api/v1/stores", "/api/v1/me", "/api/v1/admin")):
            return None
        if me is None:
            return 401, {"code": "UNAUTHENTICATED"}
        if path == "/api/v1/wallet":
            return 200, {"balanceMinor": self._bal(me)}
        if path == "/api/v1/dev/topup":
            self.balances[me] = self._bal(me) + data["amountMinor"]
            return 200, {"balanceMinor": self.balances[me]}
        if path == "/api/v1/transfer-intents" and method == "POST":
            iid = str(uuid.uuid4())
            self.intents[iid] = dict(id=iid, frm=me, to=data["toUserId"], amount=data["amountMinor"], kind="P2P", ref=data.get("reference"), status="CREATED")
            return 201, {"id": iid, "status": "CREATED"}
        m = re.fullmatch(r"/api/v1/transfer-intents/([^/]+)/(confirm|cancel)", path)
        if m:
            return self._intent_action(me, m.group(1), m.group(2))
        if path == "/api/v1/transfers":
            return 200, [dict(id=t["id"], intentId=t["intentId"], kind=t["kind"]) for t in self.transfers if me in (t["frm"], t["to"])]
        if path == "/api/v1/wallet/entries":
            mine = any(me in (t["frm"], t["to"]) for t in self.transfers if t["id"] in self.reversed)
            return 200, {"items": [{"kind": "REVERSAL"}] if mine else [], "nextBefore": None}
        return None

    def _intent_action(self, me, intent_id, action):
        it = self.intents.get(intent_id)
        if not it or it["frm"] != me:
            return 404, {"code": "INTENT_NOT_FOUND"}
        if action == "cancel":
            if it["status"] == "CREATED":
                it["status"] = "CANCELLED"
            return 200, {"status": it["status"]}
        if it["status"] == "COMPLETED":
            return 200, {"status": "COMPLETED"}                     # idempotent: same answer, no second charge
        if self._bal(me) < it["amount"]:
            return 422, {"code": "INSUFFICIENT_FUNDS"}              # nothing changes, the intent stays CREATED
        self.balances[me] -= it["amount"]
        if it["kind"] == "P2P":
            self.balances[it["to"]] = self._bal(it["to"]) + it["amount"]
        self.transfers.append(dict(id=str(uuid.uuid4()), intentId=it["id"], frm=it["frm"], to=it["to"], amountMinor=it["amount"], kind=it["kind"]))
        it["status"] = "COMPLETED"
        ref = it["ref"]
        if it["kind"] == "P2P" and ref and ref.get("type") == "chat" and ref["id"] in self.rooms:
            self.rooms[ref["id"]]["messages"].append({"kind": "payment", "payment": {"intentId": it["id"], "amountMinor": it["amount"]}})
        if it["kind"] == "ORDER":
            order = self.orders[ref["id"]]
            order["status"] = "paid"
            if order.get("giftFor") and order.get("context") and order["context"]["roomId"] in self.rooms:
                self.rooms[order["context"]["roomId"]]["messages"].append({"kind": "order", "order": {"orderId": order["id"]}})
        return 200, {"status": "COMPLETED"}

    # ------------------------------------------------------------------ wallet admin (four-eyes)
    def _admin(self, method, path, me, data, headers):
        if not path.startswith("/api/v1/admin/"):
            return None
        if me is None:
            return 401, {"code": "UNAUTHENTICATED"}
        m = re.fullmatch(r"/api/v1/admin/transfers/([^/]+)/reversal", path)
        if m:
            aid = str(uuid.uuid4())
            self.actions[aid] = dict(by=me, transfer=m.group(1))
            return 201, {"id": aid, "status": "PENDING"}
        m = re.fullmatch(r"/api/v1/admin/actions/([^/]+)/approve", path)
        if m:
            action = self.actions[m.group(1)]
            if action["by"] == me:
                return 403, {"code": "FOUR_EYES"}
            t = next(t for t in self.transfers if t["id"] == action["transfer"])
            self.balances[t["to"]] -= t["amountMinor"]
            self.balances[t["frm"]] += t["amountMinor"]
            self.reversed.add(t["id"])
            return 200, {"status": "APPROVED"}
        if path == "/api/v1/admin/reconciliation":
            return 200, []
        return None

    # ------------------------------------------------------------------ chat-service
    def _chat(self, method, path, me, data, headers):
        if not path.startswith("/api/") or path.startswith("/api/v1/"):
            return None
        if me is None:
            return 401, {"code": "UNAUTHENTICATED"}
        if path == "/api/me":
            return 200, {"id": me}
        if path == "/api/rooms/direct" and method == "POST":
            room = self.rooms.setdefault("room-1", {"id": "room-1", "messages": []})
            return 200, {"id": room["id"]}
        if path == "/api/rooms":
            return 200, [{"id": k, "unreadCount": len(v["messages"])} for k, v in self.rooms.items()]
        m = re.fullmatch(r"/api/rooms/([^/]+)/messages", path)
        if m:
            return 200, self.rooms[m.group(1)]["messages"]
        return None

    # ------------------------------------------------------------------ store-backend
    def _store(self, method, path, me, data, headers):
        if path == "/admin":
            host = headers.get("Host") or "localhost"
            return 302, None, {"Location": f"http://{host}{REALM}/protocol/openid-connect/auth?client_id=laravel-admin"}
        if path == "/api/v1/products" and method == "GET":
            return 200, {"items": [self._product(p) for p in self.catalog], "page": 1, "perPage": 24, "total": len(self.catalog)}
        if path == "/api/v1/products/hot":
            return 200, [self._product(p) for p in self.catalog if p["isHot"] and p["stock"] > 0]
        m = re.fullmatch(r"/api/v1/products/([^/]+)", path)
        if m:
            found = next((p for p in self.catalog if p["slug"] == m.group(1)), None)
            return (200, self._product(found)) if found else (404, {"message": "Not Found"})
        if path not in ("/api/v1/orders", "/api/v1/stores", "/api/v1/me/store") and not path.startswith("/api/v1/orders/"):
            return None
        if me is None:
            return 401, {"code": "UNAUTHENTICATED"}
        if path == "/api/v1/me/store":
            return 200, {"store": self.stores.get(me)}
        if path == "/api/v1/stores" and method == "POST":
            if me in self.stores:
                return 409, {"code": "STORE_EXISTS"}
            self.stores[me] = {"name": data.get("name"), "status": "pending"}
            return 201, self.stores[me]
        if path == "/api/v1/orders" and method == "POST":
            return self._create_order(me, data)
        if path == "/api/v1/orders":
            return 200, [o for o in self.orders.values() if o["buyerUserId"] == me]
        order = self.orders.get(path.rsplit("/", 1)[1])
        return (200, order) if order else (404, {"code": "ORDER_NOT_FOUND"})

    @staticmethod
    def _product(p):
        return {"id": p["id"], "slug": p["slug"], "name": p["name"], "priceMinor": p["priceMinor"], "currency": "GMD", "stock": p["stock"], "isHot": p["isHot"]}

    def _create_order(self, me, data):
        total = 0
        for line in data.get("items", []):
            product = next((p for p in self.catalog if p["id"] == line["productId"]), None)
            if product is None:
                return 422, {"code": "PRODUCT_NOT_FOUND"}
            total += product["priceMinor"] * line["quantity"]            # the STORE prices the order, never the client
        oid, iid = str(uuid.uuid4()), str(uuid.uuid4())
        self.orders[oid] = dict(id=oid, status="pending_payment", totalMinor=total, buyerUserId=me, giftFor=data.get("giftFor"),
                                context=data.get("context"), payment={"intentId": iid})
        self.intents[iid] = dict(id=iid, frm=me, to="escrow", amount=total, kind="ORDER", ref={"type": "order", "id": oid}, status="CREATED")
        return 201, self.orders[oid]


def make_handler(stack):
    class Handler(BaseHTTPRequestHandler):
        def _serve(self):
            length = int(self.headers.get("Content-Length") or 0)
            status, body, extra = stack.handle(self.command, self.path, self.headers, self.rfile.read(length) if length else b"")
            payload = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = _serve

        def log_message(self, fmt, *args):
            print(f"[mock-stack] {self.command} {self.path} -> {fmt % args}")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=9977)
    ap.add_argument("--catalog", default=str(DEFAULT_CATALOG))
    args = ap.parse_args()
    print(f"[mock-stack] serving on http://127.0.0.1:{args.port} (Keycloak, wallet, chat, store stubs). Ctrl-C to stop.")
    HTTPServer(("127.0.0.1", args.port), make_handler(MockStack(args.catalog))).serve_forever()


if __name__ == "__main__":
    main()
