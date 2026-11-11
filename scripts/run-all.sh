#!/usr/bin/env bash
set -euo pipefail

echo "=== Starting backing infrastructure (Docker Compose) ==="
docker compose up -d

# Trap to kill background service processes when you press Ctrl-C
trap "echo 'Stopping services...'; kill 0" EXIT

echo "=== Starting Wallet Service (:8081) ==="
(cd services/wallet-service && mvn spring-boot:run) &

echo "=== Starting Chat Service (:4000) ==="
(cd services/chat-service && npm run dev) &

echo "=== Starting Store Backend (:8000) ==="
(cd services/store-backend && php artisan serve) &

echo "=== All services launched! Press Ctrl-C to stop all. ==="
wait
