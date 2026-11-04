package com.chatpay.wallet.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.MissingNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.RabbitMQContainer;
import org.testcontainers.utility.DockerImageName;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Base class for the wallet's integration tests: the REAL application (security filter chain, Flyway migrations, outbox, AMQP)
 * on a REAL Postgres and RabbitMQ started once in Docker and shared by every test class.
 *
 * Isolation: every test uses brand-new random user ids and never cleans tables (the money tables are append-only by design,
 * and the system accounts such as escrow are shared). So tests assert on DELTAS and on their own users, and on the global
 * "books reconcile" check, never on absolute totals.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestJwtConfig.class)
public abstract class WalletIntegrationTest {

    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"))
            .withDatabaseName("wallet").withUsername("wallet").withPassword("wallet");

    private static final RabbitMQContainer RABBIT = new RabbitMQContainer(DockerImageName.parse("rabbitmq:3.13-management-alpine"));

    static {
        POSTGRES.start();
        RABBIT.start();
    }

    @DynamicPropertySource
    static void containerProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.rabbitmq.host", RABBIT::getHost);
        registry.add("spring.rabbitmq.port", RABBIT::getAmqpPort);
        registry.add("spring.rabbitmq.username", RABBIT::getAdminUsername);
        registry.add("spring.rabbitmq.password", RABBIT::getAdminPassword);
    }

    @Autowired protected MockMvc mvc;
    @Autowired protected JdbcTemplate jdbc;
    @Autowired protected ObjectMapper json;

    /** An HTTP answer: status plus parsed JSON body (MissingNode when there is none). */
    public record Response(int status, JsonNode body) {
        public String text(String field) { return body.path(field).asText(); }
        public long number(String field) { return body.path(field).asLong(); }
        public String code() { return text("code"); }
        @Override public String toString() { return status + " " + body; }
    }

    // ------------------------------------------------------------------ identities
    protected static String newUser() { return UUID.randomUUID().toString(); }

    /** A bearer token for an ordinary user whose Keycloak id is `userId`. */
    protected static String as(String userId) { return TestJwtConfig.token(userId); }

    /** The store backend's service account (realm role wallet-merchant). */
    protected static String merchant() { return TestJwtConfig.token("service-account-laravel-service", "wallet-merchant"); }

    /** A finance admin (realm role wallet-admin). */
    protected static String admin(String adminId) { return TestJwtConfig.token(adminId, "wallet-admin"); }

    // ------------------------------------------------------------------ HTTP
    protected Response call(HttpMethod method, String path, String token, Object body) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.request(method, path).accept(MediaType.APPLICATION_JSON);
            if (token != null) {
                request.header(HttpHeaders.AUTHORIZATION, "Bearer " + token);
            }
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body));
            }
            MockHttpServletResponse response = mvc.perform(request).andReturn().getResponse();
            String content = response.getContentAsString();
            return new Response(response.getStatus(), content.isBlank() ? MissingNode.getInstance() : json.readTree(content));
        } catch (Exception e) {
            throw new IllegalStateException("request failed: " + method + " " + path, e);
        }
    }

    protected Response get(String path, String token) { return call(HttpMethod.GET, path, token, null); }

    protected Response post(String path, String token, Object body) { return call(HttpMethod.POST, path, token, body); }

    // ------------------------------------------------------------------ wallet operations
    /** Dev top-up (profile "dev", on by default). Returns the new balance. */
    protected long topUp(String userId, long amountMinor) {
        Response r = post("/api/v1/dev/topup", as(userId), Map.of("amountMinor", amountMinor));
        assertThat(r.status()).as("top-up: %s", r).isEqualTo(200);
        return r.number("balanceMinor");
    }

    protected long balance(String userId) {
        Response r = get("/api/v1/wallet", as(userId));
        assertThat(r.status()).as("balance: %s", r).isEqualTo(200);
        return r.number("balanceMinor");
    }

    protected Response createIntent(String fromUser, String toUser, long amountMinor, String note) {
        Response r = post("/api/v1/transfer-intents", as(fromUser), Map.of("toUserId", toUser, "amountMinor", amountMinor, "note", note));
        assertThat(r.status()).as("create intent: %s", r).isEqualTo(201);
        return r;
    }

    protected Response confirm(String user, String intentId) {
        return post("/api/v1/transfer-intents/" + intentId + "/confirm", as(user), null);
    }

    protected Response cancel(String user, String intentId) {
        return post("/api/v1/transfer-intents/" + intentId + "/cancel", as(user), null);
    }

    /** Pays `amountMinor` from one user to another in one go (create + confirm). */
    protected Response pay(String fromUser, String toUser, long amountMinor) {
        Response confirmed = confirm(fromUser, createIntent(fromUser, toUser, amountMinor, "test").text("id"));
        assertThat(confirmed.status()).as("pay: %s", confirmed).isEqualTo(200);
        return confirmed;
    }

    // ------------------------------------------------------------------ database
    protected long count(String sql, Object... args) {
        Long value = jdbc.queryForObject(sql, Long.class, args);
        return value == null ? 0 : value;
    }

    /** The global safety net: every account's cached balance equals the sum of its ledger entries. */
    protected void assertBooksReconcile() {
        Response r = get("/api/v1/admin/reconciliation", admin(newUser()));
        assertThat(r.status()).as("reconciliation: %s", r).isEqualTo(200);
        assertThat(r.body().size()).as("accounts out of balance: %s", r.body()).isZero();
    }

    // ------------------------------------------------------------------ concurrency
    /**
     * Runs all tasks at the same instant (they wait on a start gate) and returns their results in order.
     * A task that has not finished after 90 seconds fails the test: that is how a deadlock shows up.
     */
    protected <T> List<T> runInParallel(List<Callable<T>> tasks) {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        CountDownLatch ready = new CountDownLatch(tasks.size());
        CountDownLatch go = new CountDownLatch(1);
        try {
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : tasks) {
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return task.call();
                }));
            }
            ready.await();
            go.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get(90, TimeUnit.SECONDS));
            }
            return results;
        } catch (TimeoutException e) {
            throw new AssertionError("A parallel request did not finish within 90 seconds: probable deadlock", e);
        } catch (Exception e) {
            throw new IllegalStateException("parallel run failed", e);
        } finally {
            pool.shutdownNow();
        }
    }
}
