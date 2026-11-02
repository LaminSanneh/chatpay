#!/usr/bin/env python3
"""
Permanent mock of the RabbitMQ *management API*, limited to what scripts/doctor.sh reads: GET /api/queues.

Why it exists: so the queue checks of doctor.sh (nobody listening, dead letters waiting, queue not created yet) can be
exercised without a broker and without ad-hoc scripts. The data comes from a static fixture file.

Run it in the FOREGROUND in its own terminal (stop with Ctrl-C), or use `make mock-rabbit`:
    python3 mock-services/rabbitmq/server.py [--port 15673] [--fixture mock-services/rabbitmq/queues.json]
Then:  RABBIT=http://127.0.0.1:15673 ./scripts/doctor.sh

The fixture is re-read on EVERY request: edit queues.json while the server runs and doctor.sh sees the change.
`handle()` is a pure function (no sockets), which is what the unit tests call.
"""
import argparse
import base64
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_FIXTURE = HERE / "queues.json"
USER, PASSWORD = "chatpay", "chatpay"       # same as docker-compose.yml


def basic_auth_ok(header, user=USER, password=PASSWORD):
    if not header or not header.startswith("Basic "):
        return False
    try:
        return base64.b64decode(header[6:]).decode() == f"{user}:{password}"
    except Exception:
        return False


def handle(method, path, auth_header, fixture_path=DEFAULT_FIXTURE):
    """Returns (status, json_body). Mirrors the real API for the one endpoint we use."""
    if method != "GET":
        return 405, {"error": "method_not_allowed"}
    if not basic_auth_ok(auth_header):
        return 401, {"error": "not_authorised", "reason": "Login failed"}
    if path.split("?")[0] == "/api/queues":
        try:
            return 200, json.loads(Path(fixture_path).read_text())
        except (OSError, ValueError) as e:
            return 500, {"error": "bad_fixture", "reason": str(e)}
    return 404, {"error": "Object Not Found", "reason": "Not Found"}


def make_handler(fixture_path):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            status, body = handle("GET", self.path, self.headers.get("Authorization"), fixture_path)
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, fmt, *args):
            print(f"[mock-rabbit] {self.command} {self.path} -> {fmt % args}")

    return Handler


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=15673)
    ap.add_argument("--fixture", default=str(DEFAULT_FIXTURE))
    args = ap.parse_args()
    print(f"[mock-rabbit] serving {args.fixture} on http://127.0.0.1:{args.port}/api/queues (user {USER}). Ctrl-C to stop.")
    HTTPServer(("127.0.0.1", args.port), make_handler(args.fixture)).serve_forever()


if __name__ == "__main__":
    main()
