#!/usr/bin/env bash
# One-time cleanup for chat queues that were created BEFORE dead-lettering existed.
# RabbitMQ refuses to redeclare an existing queue with different arguments (PRECONDITION_FAILED), so chat-service cannot add the
# dead-letter arguments to them: they must be deleted once and re-created by the service. DESTRUCTIVE: messages still in them are lost.
#   ./scripts/reset-chat-queues.sh            show the queues and how many messages would be lost
#   ./scripts/reset-chat-queues.sh --yes      delete them, then restart chat-service
RABBIT=${RABBIT:-http://localhost:15672}
RABBIT_USER=${RABBIT_USER:-chatpay}; RABBIT_PASS=${RABBIT_PASS:-chatpay}
QUEUES=(chat.wallet-events chat.store-events)

count() { curl -s -m 5 -u "$RABBIT_USER:$RABBIT_PASS" "$RABBIT/api/queues/%2F/$1" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("messages", "?"))' 2>/dev/null || echo "?"; }

if [ "${1:-}" != "--yes" ]; then
  echo "Would delete these queues (messages in them are lost):"
  for q in "${QUEUES[@]}"; do echo "  $q  ($(count "$q") message(s))"; done
  echo "Stop chat-service first, then run again with --yes."
  exit 2
fi
for q in "${QUEUES[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -u "$RABBIT_USER:$RABBIT_PASS" -X DELETE "$RABBIT/api/queues/%2F/$q")
  echo "  $q -> HTTP $code (204 deleted, 404 did not exist)"
done
echo "Now (re)start chat-service: it re-creates the queues with a dead-letter exchange, a dead-letter queue and retry queues."
