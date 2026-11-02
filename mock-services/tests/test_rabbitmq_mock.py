"""
Tests for mock-services/rabbitmq (the RabbitMQ management-API mock) and for how scripts/doctor.sh reads its fixtures.
No server is started: `handle()` is called directly, and doctor.sh reads the fixture files with RABBIT_FIXTURE.
Run with: make test-mocks
"""
import base64
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "mock-services" / "rabbitmq"
DOCTOR = ROOT / "scripts" / "doctor.sh"

spec = importlib.util.spec_from_file_location("mock_rabbit_server", FIXTURES / "server.py")
rabbit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rabbit)

GOOD = "Basic " + base64.b64encode(b"chatpay:chatpay").decode()
EXPECTED_QUEUES = {"chat.wallet-events", "chat.store-events", "store.wallet-events", "store.wallet-events.dlq"}


class HandleTests(unittest.TestCase):
    def test_queues_with_valid_credentials(self):
        status, body = rabbit.handle("GET", "/api/queues", GOOD, FIXTURES / "queues.json")
        self.assertEqual(status, 200)
        self.assertEqual({q["name"] for q in body}, EXPECTED_QUEUES)

    def test_query_string_is_ignored(self):
        self.assertEqual(rabbit.handle("GET", "/api/queues?columns=name", GOOD, FIXTURES / "queues.json")[0], 200)

    def test_missing_or_wrong_credentials_are_refused(self):
        wrong = "Basic " + base64.b64encode(b"chatpay:nope").decode()
        for header in (None, "", "Bearer abc", "Basic !!!not-base64!!!", wrong):
            self.assertEqual(rabbit.handle("GET", "/api/queues", header, FIXTURES / "queues.json")[0], 401, header)

    def test_other_paths_and_methods(self):
        self.assertEqual(rabbit.handle("GET", "/api/exchanges", GOOD)[0], 404)
        self.assertEqual(rabbit.handle("POST", "/api/queues", GOOD)[0], 405)

    def test_a_broken_fixture_is_reported_not_crashed_on(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text("{ not json")
            self.assertEqual(rabbit.handle("GET", "/api/queues", GOOD, bad)[0], 500)
            self.assertEqual(rabbit.handle("GET", "/api/queues", GOOD, Path(tmp) / "missing.json")[0], 500)

    def test_the_fixture_is_re_read_on_every_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            f = Path(tmp) / "q.json"
            f.write_text("[]")
            self.assertEqual(rabbit.handle("GET", "/api/queues", GOOD, f)[1], [])
            f.write_text('[{"name": "x"}]')
            self.assertEqual(rabbit.handle("GET", "/api/queues", GOOD, f)[1], [{"name": "x"}])


class FixtureTests(unittest.TestCase):
    def test_every_fixture_is_a_list_of_well_formed_queues(self):
        files = sorted(FIXTURES.glob("queues*.json"))
        self.assertGreaterEqual(len(files), 5)
        for f in files:
            queues = json.loads(f.read_text())
            names = [q["name"] for q in queues]
            self.assertEqual(len(names), len(set(names)), f"duplicate queue names in {f.name}")
            for q in queues:
                for key in ("name", "consumers", "messages_ready", "messages_unacknowledged"):
                    self.assertIn(key, q, f"{f.name}: {q.get('name')} lacks {key}")
                self.assertTrue(set(names) <= EXPECTED_QUEUES, f"{f.name} has an unknown queue")

    def test_the_default_fixture_is_the_healthy_one(self):
        for q in json.loads((FIXTURES / "queues.json").read_text()):
            self.assertEqual(q["messages_ready"], 0)
            if not q["name"].endswith(".dlq"):
                self.assertGreaterEqual(q["consumers"], 1, q["name"])


class DoctorAgainstFixtures(unittest.TestCase):
    """Runs scripts/doctor.sh with RABBIT_FIXTURE. Run from a temp directory so `docker compose` can never touch a real stack."""

    @staticmethod
    def report(fixture):
        env = dict(os.environ, RABBIT_FIXTURE=str(FIXTURES / fixture))
        r = subprocess.run([str(DOCTOR)], env=env, capture_output=True, text=True, timeout=120, cwd=tempfile.gettempdir())
        out = r.stdout
        return out.split("RabbitMQ queues", 1)[1].split("Events stuck", 1)[0]

    @staticmethod
    def line(report, queue):
        return next(l for l in report.splitlines() if l.strip().startswith(queue + " "))

    def test_says_where_the_queues_come_from(self):
        self.assertIn("FIXTURE FILE", self.report("queues.json"))

    def test_healthy(self):
        r = self.report("queues.json")
        self.assertNotIn("NOBODY IS LISTENING", r)
        self.assertNotIn("DEAD LETTERS", r)
        self.assertNotIn("backlog", r)
        self.assertNotIn("not created yet", r)
        self.assertIn("consumers=1 ready=0 unacked=0", self.line(r, "chat.wallet-events"))

    def test_nobody_listening_is_flagged_on_the_right_queues(self):
        r = self.report("queues.no-consumers.json")
        self.assertIn("NOBODY IS LISTENING (chat-service", self.line(r, "chat.store-events"))
        self.assertIn("NOBODY IS LISTENING (store-backend", self.line(r, "store.wallet-events"))
        self.assertNotIn("NOBODY", self.line(r, "chat.wallet-events"))
        self.assertNotIn("NOBODY", self.line(r, "store.wallet-events.dlq"))      # a DLQ is supposed to have no consumers

    def test_dead_letters_are_flagged(self):
        r = self.report("queues.dead-letters.json")
        self.assertIn("DEAD LETTERS", self.line(r, "store.wallet-events.dlq"))
        self.assertIn("ready=2", self.line(r, "store.wallet-events.dlq"))

    def test_growing_backlog_is_flagged(self):
        self.assertIn("backlog growing", self.line(self.report("queues.backlog.json"), "chat.wallet-events"))

    def test_queues_that_were_never_created_are_reported_as_such(self):
        r = self.report("queues.not-created.json")
        for q in ("chat.store-events", "store.wallet-events", "store.wallet-events.dlq"):
            self.assertIn("not created yet", self.line(r, q))
        self.assertNotIn("not created yet", self.line(r, "chat.wallet-events"))

    def test_an_unreadable_fixture_is_a_clear_error(self):
        env = dict(os.environ, RABBIT_FIXTURE="/nonexistent/queues.json")
        r = subprocess.run([str(DOCTOR)], env=env, capture_output=True, text=True, timeout=120, cwd=tempfile.gettempdir())
        self.assertIn("fixture file not readable", r.stdout)


if __name__ == "__main__":
    unittest.main()
