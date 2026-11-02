# First end-to-end run

Do the stages in order. Each ends with a check; if it fails, stop and send the output of that stage.
Before anything: `make check` (no services needed) and `make doctor-fixtures` to see what doctor.sh's failure reports look like.

## 0. Prerequisites
Docker, Java 21 + Maven (`brew install openjdk@21 maven`; `export JAVA_HOME=$(/usr/libexec/java_home -v 21)`), Node 22, PHP 8.3 + Composer.

## 1. Infrastructure
    docker compose up -d
    docker compose rm -sf keycloak && docker compose up -d keycloak     # ONLY if Keycloak ran before this round: its realm import never re-runs for an existing realm
    make doctor                                                          # Keycloak, three Postgres, RabbitMQ should be up; services DOWN is expected for now

## 2. Wallet (never compiled yet: the biggest unknown)
    cd services/wallet-service
    mvn -q -DskipTests compile        # 2a. compiles? send the first ~40 lines of errors
    mvn -q test                       # 2b. ModularityTests: module boundaries. A failure names the offending class
    mvn spring-boot:run               # 2c. starts on :8081 (needs docker compose up)
Check: `curl localhost:8081/actuator/health` gives {"status":"UP"}. Likely first failures:
- Hibernate "Schema-validation": an entity and a Flyway migration disagree: send the message (a quick workaround is `spring.jpa.hibernate.ddl-auto=none`).
- Connection refused :5433 or :5672: docker compose is not up.
- 401 on every call later: issuer mismatch. The token's issuer must be exactly http://localhost:8080/realms/chatpay.

## 3. Chat service and apps
    cd services/chat-service && cp -n .env.example .env && npm i && npm run dev      # :4000
    cd apps/web && cp -n .env.example .env.local && npm i && npm run dev             # :3000
    cd apps/store-web && cp -n .env.example .env.local && npm i && npm run dev       # :3001

## 4. Store backend
    cd services/store-backend && ./setup.sh && ./dev.sh       # :8000, plus events:consume, outbox:relay, schedule:work

## 5. Everything together
    make doctor          # all green; queues chat.wallet-events, chat.store-events, store.wallet-events each show consumers=1
    ./scripts/e2e.sh     # sign-in -> top-up -> chat room -> payment + bubble -> insufficient funds -> gift order + bubble -> two-person reversal

## 6. By hand in the browsers
alice and bob in two windows: DM, pay, see bubbles and balances; private group with an invite; @mention and typing; Shop panel: buy for yourself and as a gift;
storefront: browse anonymously, checkout, order becomes paid; /vendor as bob: ship, deliver; /admin as finance1 and finance2: a correction needs both.

## When something fails, send me
The failing stage number, the command, and the output. `make doctor` output helps for anything involving queues, ports or Keycloak.
