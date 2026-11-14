"""Checks the shared event fixtures and index.json themselves (the producers' and consumers' tests check them against the real code).
Run with: make test-contracts  (also part of make check)."""
import json
import re
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVENTS = ROOT / "contracts" / "events"
SERVICES = {"wallet-service", "store-backend", "chat-service"}
EXCHANGES = {"wallet.events": "wallet-service", "store.events": "store-backend"}     # exchange -> the only service allowed to publish to it
MONEY = ("amountMinor", "commissionMinor", "totalMinor", "unitPriceMinor")
KINDS = {"transfer.completed": {"P2P", "ORDER_PAYMENT"}, "settlement.completed": {"RELEASE", "REFUND"}}


def load(name):
    return json.loads((EVENTS / name).read_text())


INDEX = load("index.json")


class IndexTests(unittest.TestCase):
    def test_every_fixture_is_listed_once_and_every_listing_exists(self):
        listed = [e["file"] for e in INDEX]
        self.assertEqual(len(listed), len(set(listed)), "duplicate entries in index.json")
        on_disk = {p.name for p in EVENTS.glob("*.json")} - {"index.json"}
        self.assertEqual(set(listed), on_disk)

    def test_entries_are_well_formed(self):
        for e in INDEX:
            self.assertEqual(set(e) - {"note"}, {"file", "exchange", "routingKey", "producer", "consumers"}, e["file"])
            self.assertIn(e["exchange"], EXCHANGES, e["file"])
            self.assertEqual(e["producer"], EXCHANGES[e["exchange"]], f"{e['file']}: only the owner publishes to {e['exchange']}")
            self.assertTrue(e["file"].startswith(e["routingKey"]), f"{e['file']} should be named after its routing key")
            self.assertTrue(e["consumers"], e["file"])
            self.assertTrue(set(e["consumers"]) <= SERVICES, e["file"])
            self.assertNotIn(e["producer"], e["consumers"], f"{e['file']}: a service does not consume its own events")

    def test_every_routing_key_is_documented(self):
        docs = (ROOT / "docs" / "events.md").read_text()
        for key in {e["routingKey"] for e in INDEX}:
            self.assertIn(key, docs, f"{key} is not mentioned in docs/events.md")


class PayloadTests(unittest.TestCase):
    def test_common_rules(self):
        for e in INDEX:
            p = load(e["file"])
            self.assertRegex(p["correlationId"], r"\A[A-Za-z0-9._:-]{1,64}\Z", f"{e['file']}: every event carries the correlation id of the request that caused it")
            self.assertIsInstance(p["version"], int, e["file"])
            self.assertGreaterEqual(p["version"], 1, e["file"])
            self.assertIsInstance(p["occurredAt"], str, e["file"])
            datetime.fromisoformat(p["occurredAt"])                    # ISO-8601, with Z or an offset
            self.assertRegex(p["occurredAt"], r"(Z|[+-]\d\d:\d\d)$", f"{e['file']}: a time zone is required")
            for field in MONEY:
                if field in p:
                    self.assertTrue(isinstance(p[field], int) and not isinstance(p[field], bool) and p[field] >= 0, f"{e['file']}.{field}")
            if "currency" in p:
                self.assertRegex(p["currency"], r"^[A-Z]{3}$", e["file"])
            for key, value in p.items():
                if key.endswith("Id"):
                    self.assertIsInstance(value, str, f"{e['file']}.{key}: ids are strings")

    def test_wallet_events_carry_a_known_kind(self):
        for e in INDEX:
            allowed = KINDS.get(e["routingKey"])
            if allowed:
                self.assertIn(load(e["file"])["kind"], allowed, e["file"])

    def test_each_wallet_kind_has_a_fixture(self):
        seen = {(e["routingKey"], load(e["file"])["kind"]) for e in INDEX if e["routingKey"] in KINDS}
        wanted = {(k, kind) for k, kinds in KINDS.items() for kind in kinds}
        self.assertEqual(seen, wanted, "every kind of wallet event needs an example")

    def test_order_events_are_consistent_with_each_other(self):
        pay = load("transfer.completed.order-payment.json")
        release = load("settlement.completed.release.json")
        paid = load("order.paid.json")
        self.assertEqual((pay["referenceType"], pay["referenceId"]), ("order", release["orderId"]))
        self.assertEqual(paid["orderId"], pay["referenceId"])
        self.assertEqual(paid["correlationId"], pay["correlationId"], "order.paid is caused by the payment, so it carries the same correlation id")
        self.assertEqual(paid["totalMinor"], pay["amountMinor"])
        self.assertEqual(sum(i["quantity"] * i["unitPriceMinor"] for i in paid["items"]), paid["totalMinor"])
        self.assertEqual(release["amountMinor"], pay["amountMinor"])
        self.assertLessEqual(release["commissionMinor"], release["amountMinor"])
        self.assertEqual(pay["toUserId"], "store:" + release["storeId"])
        self.assertEqual(load("store.opened.json")["storeId"], release["storeId"])

    def test_refund_carries_no_commission(self):
        self.assertEqual(load("settlement.completed.refund.json")["commissionMinor"], 0)


if __name__ == "__main__":
    unittest.main()
