# Developer shortcuts. Everything here is a permanent, reviewable command: no ad-hoc scripts, no background processes.
# `make help` lists the targets. Mock servers run in the FOREGROUND, each in its own terminal (Ctrl-C stops them).
SHELL := /bin/bash
PYTHON ?= python3
MOCK_STACK := http://127.0.0.1:9977
MOCK_RABBIT := http://127.0.0.1:15673

.DEFAULT_GOAL := help
.PHONY: help check check-scripts test-mocks doctor doctor-fixtures doctor-mock-rabbit mock-rabbit mock-stack verify-mock e2e-mock

help: ## list the targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-20s %s\n", $$1, $$2}'

check: check-scripts test-mocks ## everything that needs no running service (run it before you commit)

check-scripts: ## syntax-check every shell script and mock server, validate every fixture
	@for f in scripts/*.sh services/store-backend/*.sh; do [ -f "$$f" ] || continue; bash -n "$$f" && echo "ok  $$f"; done
	@$(PYTHON) -m py_compile mock-services/rabbitmq/server.py mock-services/stack/server.py && echo "ok  mock servers compile"
	@for f in mock-services/rabbitmq/*.json mock-services/stack/*.json; do $(PYTHON) -c "import json,sys; json.load(open(sys.argv[1]))" "$$f" && echo "ok  $$f"; done

test-mocks: ## unit tests of both mock servers and of doctor.sh against every fixture (starts no server)
	$(PYTHON) -m unittest discover -s mock-services/tests -v

doctor: ## live status of the real stack: services, issuer, RabbitMQ consumers and dead letters, stuck outbox rows
	./scripts/doctor.sh

doctor-fixtures: ## doctor.sh's RabbitMQ report for every fixture (shows what each failure looks like)
	@for f in mock-services/rabbitmq/queues*.json; do echo "=== $$f"; RABBIT_FIXTURE=$$f ./scripts/doctor.sh 2>&1 | sed -n '/RabbitMQ queues/,/Events stuck/p' | sed '$$d'; done

mock-rabbit: ## run the RabbitMQ management-API mock on :15673 (own terminal), serving mock-services/rabbitmq/queues.json
	$(PYTHON) mock-services/rabbitmq/server.py

doctor-mock-rabbit: ## second terminal, mock-rabbit running: doctor.sh against the mock management API
	RABBIT=$(MOCK_RABBIT) ./scripts/doctor.sh

mock-stack: ## run the Keycloak/wallet/chat/store stubs on :9977 (own terminal)
	$(PYTHON) mock-services/stack/server.py

verify-mock: ## second terminal, mock-stack running: the store backend's verify.sh against the stubs
	BASE=$(MOCK_STACK) KC=$(MOCK_STACK)/realms/chatpay WALLET=$(MOCK_STACK) ./services/store-backend/verify.sh

e2e-mock: ## second terminal, mock-stack running: scripts/e2e.sh against the stubs
	KC=$(MOCK_STACK)/realms/chatpay WALLET=$(MOCK_STACK) CHAT=$(MOCK_STACK) STORE=$(MOCK_STACK) ./scripts/e2e.sh
