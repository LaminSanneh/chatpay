#!/usr/bin/env bash
# Starts everything the store backend needs in ONE terminal and prefixes each line with the process name:
#   web       php artisan serve              the API and the back office on :8000
#   events    php artisan events:consume     listens to the wallet's events (payment received, settlement done)
#   outbox    php artisan outbox:relay       publishes store.opened / store.closed / order.paid to RabbitMQ
#   schedule  php artisan schedule:work      expires unpaid orders (every minute), pays out delivered orders (every 5 minutes)
# Ctrl-C stops all of them. (It does not restart a process that crashes: Supervisor does that in production.)
set -uo pipefail
cd "$(dirname "$0")"
[ -f artisan ] || { echo "Run ./setup.sh first"; exit 1; }

pids=()

# Stop a process and everything it started (artisan serve, for one, starts its own php server).
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$child"; done
  kill "$1" 2>/dev/null
}

stop_all() {
  trap - INT TERM EXIT
  echo; echo "Stopping everything..."
  for pid in "${pids[@]}"; do kill_tree "$pid"; done
  wait 2>/dev/null
  exit 0
}
trap stop_all INT TERM EXIT

start() {
  local name=$1; shift
  ( "$@" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do printf '[%s] %s\n' "$name" "$line"; done ) &
  pids+=($!)
}

start web      php artisan serve --port=8000
start events   php artisan events:consume
start outbox   php artisan outbox:relay
start schedule php artisan schedule:work
wait
