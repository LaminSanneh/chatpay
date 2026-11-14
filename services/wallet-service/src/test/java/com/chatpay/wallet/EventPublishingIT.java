package com.chatpay.wallet;

import com.chatpay.wallet.support.Contracts;
import com.chatpay.wallet.support.OrderWalletIntegrationTest;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.amqp.core.AmqpAdmin;
import org.springframework.amqp.core.Binding;
import org.springframework.amqp.core.Message;
import org.springframework.amqp.core.Queue;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.rabbit.core.RabbitTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

/**
 * The events other services depend on, checked on the REAL broker. The chat service and the store backend consume exactly these
 * messages, so the field names asserted here are a CONTRACT: if one of these tests fails because a field changed, a consumer broke.
 * The outbox guarantee is checked too: an event is stored with the money movement, published after commit, and marked complete.
 */
@Timeout(180)
class EventPublishingIT extends OrderWalletIntegrationTest {

    private static final String EXCHANGE = "wallet.events";

    private static final Set<String> TRANSFER_COMPLETED_FIELDS = Set.of("version", "transferId", "intentId", "kind", "fromUserId", "toUserId",
            "amountMinor", "currency", "note", "referenceType", "referenceId", "occurredAt");
    private static final Set<String> SETTLEMENT_COMPLETED_FIELDS = Set.of("version", "settlementId", "orderId", "kind", "storeId", "payerUserId",
            "amountMinor", "commissionMinor", "currency", "occurredAt");

    @Autowired AmqpAdmin amqp;
    @Autowired RabbitTemplate rabbit;

    private record Received(String routingKey, JsonNode body, Map<String, Object> headers) {}

    private final List<Received> received = new ArrayList<>();
    private String queue;

    @BeforeEach
    void listenToTheExchange() {
        queue = "it-" + UUID.randomUUID();
        amqp.declareExchange(new TopicExchange(EXCHANGE, true, false));      // same arguments as the application's own declaration
        amqp.declareQueue(new Queue(queue, false, false, false));
        for (String key : List.of("transfer.completed", "settlement.completed")) {
            amqp.declareBinding(new Binding(queue, Binding.DestinationType.QUEUE, EXCHANGE, key, null));
        }
    }

    @AfterEach
    void stopListening() {
        amqp.deleteQueue(queue);
    }

    /** Reads everything currently waiting on our private queue. Other tests' events arrive too; tests filter by their own ids. */
    private void pump() {
        Message message;
        while ((message = rabbit.receive(queue, 300)) != null) {
            try {
                received.add(new Received(message.getMessageProperties().getReceivedRoutingKey(), json.readTree(message.getBody()), message.getMessageProperties().getHeaders()));
            } catch (IOException e) {
                throw new IllegalStateException("an event was not valid JSON", e);
            }
        }
    }

    private Received awaitEvent(String routingKey, Predicate<JsonNode> mine) {
        AtomicReference<Received> found = new AtomicReference<>();
        await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(300)).until(() -> {
            pump();
            found.set(received.stream().filter(r -> r.routingKey().equals(routingKey) && mine.test(r.body())).findFirst().orElse(null));
            return found.get() != null;
        });
        return found.get();
    }

    private long countOf(String routingKey, Predicate<JsonNode> mine) {
        pump();
        return received.stream().filter(r -> r.routingKey().equals(routingKey) && mine.test(r.body())).count();
    }

    private static Set<String> fieldNames(JsonNode node) {
        Set<String> names = new HashSet<>();
        node.fieldNames().forEachRemaining(names::add);
        return names;
    }

    // ------------------------------------------------------------------ transfer.completed
    @Test
    void aConfirmedPaymentIsPublishedOnceWithExactlyTheContractFields() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        Response intent = post("/api/v1/transfer-intents", as(alice),
                Map.of("toUserId", bob, "amountMinor", 2_500, "note", "lunch", "reference", Map.of("type", "chat", "id", "room-7")));
        String intentId = intent.text("id");
        Response confirmed = confirm(alice, intentId);

        Received event = awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(intentId));

        JsonNode body = event.body();
        assertThat(fieldNames(body)).as("the contract the chat service and the store backend rely on").isEqualTo(TRANSFER_COMPLETED_FIELDS);
        assertThat(body.path("version").asInt()).isEqualTo(1);
        assertThat(body.path("transferId").asText()).isEqualTo(confirmed.text("transferId"));
        assertThat(body.path("kind").asText()).isEqualTo("P2P");
        assertThat(body.path("fromUserId").asText()).isEqualTo(alice);
        assertThat(body.path("toUserId").asText()).isEqualTo(bob);
        assertThat(body.path("amountMinor").asLong()).isEqualTo(2_500);
        assertThat(body.path("currency").asText()).isEqualTo("GMD");
        assertThat(body.path("note").asText()).isEqualTo("lunch");
        assertThat(body.path("referenceType").asText()).isEqualTo("chat");
        assertThat(body.path("referenceId").asText()).isEqualTo("room-7");
        assertThat(Instant.parse(body.path("occurredAt").asText())).isBefore(Instant.now().plusSeconds(5));

        confirm(alice, intentId);                                                  // a replayed confirm must not publish again
        pay(alice, bob, 100);                                                      // a later event proves the first one is not still on its way
        awaitEvent("transfer.completed", b -> b.path("amountMinor").asLong() == 100 && b.path("fromUserId").asText().equals(alice));
        assertThat(countOf("transfer.completed", b -> b.path("intentId").asText().equals(intentId))).isEqualTo(1);
    }

    @Test
    void theEventIsStoredWithTheMoneyMovementAndMarkedCompleteOncePublished() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 1_000);
        String intentId = createIntent(alice, bob, 400, "outbox").text("id");
        confirm(alice, intentId);
        awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(intentId));

        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            assertThat(count("select count(*) from event_publication where serialized_event like ? and completion_date is not null", "%" + intentId + "%"))
                    .as("published and marked complete").isGreaterThanOrEqualTo(1);
            assertThat(count("select count(*) from event_publication where serialized_event like ? and completion_date is null", "%" + intentId + "%"))
                    .as("nothing left waiting to be published").isZero();
        });
    }

    @Test
    void aPaymentThatFailsPublishesNothing() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 500);
        String failedIntent = createIntent(alice, bob, 5_000, "too much").text("id");
        assertThat(confirm(alice, failedIntent).status()).isEqualTo(422);

        topUp(alice, 1_000);
        pay(alice, bob, 100);                                                      // marker: once it arrives, anything from the failed one would have too
        awaitEvent("transfer.completed", b -> b.path("amountMinor").asLong() == 100 && b.path("fromUserId").asText().equals(alice));

        assertThat(countOf("transfer.completed", b -> b.path("intentId").asText().equals(failedIntent))).isZero();
        assertThat(count("select count(*) from event_publication where serialized_event like ?", "%" + failedIntent + "%"))
                .as("not even stored: the rollback took the event with it").isZero();
    }

    @Test
    void anOrderPaymentIsPublishedAsAnOrderPaymentForTheStoreBackend() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 6_000);
        String intentId = payOrder(buyer, store, order, 6_000);

        JsonNode body = awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(intentId)).body();

        assertThat(fieldNames(body)).isEqualTo(TRANSFER_COMPLETED_FIELDS);
        assertThat(body.path("kind").asText()).isEqualTo("ORDER_PAYMENT");
        assertThat(body.path("fromUserId").asText()).isEqualTo(buyer);
        assertThat(body.path("toUserId").asText()).isEqualTo("store:" + store);
        assertThat(body.path("referenceType").asText()).isEqualTo("order");
        assertThat(body.path("referenceId").asText()).isEqualTo(order);
        assertThat(body.path("amountMinor").asLong()).isEqualTo(6_000);
    }

    // ------------------------------------------------------------------ settlement.completed
    @Test
    void aReleaseAndARefundArePublishedAsSettlements() {
        String buyer = newUser(), store = newStore(), releasedOrder = newOrder(), refundedOrder = newOrder();
        topUp(buyer, 3_000);
        payOrder(buyer, store, releasedOrder, 2_000);
        payOrder(buyer, store, refundedOrder, 1_000);

        Response released = release(releasedOrder, newKey(), 200, null);
        Response refunded = refund(refundedOrder, newKey(), null);

        JsonNode releaseEvent = awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(releasedOrder)).body();
        assertThat(fieldNames(releaseEvent)).as("contract").isEqualTo(SETTLEMENT_COMPLETED_FIELDS);
        assertThat(releaseEvent.path("version").asInt()).isEqualTo(1);
        assertThat(releaseEvent.path("settlementId").asText()).isEqualTo(released.text("id"));
        assertThat(releaseEvent.path("kind").asText()).isEqualTo("RELEASE");
        assertThat(releaseEvent.path("storeId").asText()).isEqualTo(store);
        assertThat(releaseEvent.path("payerUserId").asText()).isEqualTo(buyer);
        assertThat(releaseEvent.path("amountMinor").asLong()).isEqualTo(2_000);
        assertThat(releaseEvent.path("commissionMinor").asLong()).isEqualTo(200);
        assertThat(releaseEvent.path("currency").asText()).isEqualTo("GMD");

        JsonNode refundEvent = awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(refundedOrder)).body();
        assertThat(refundEvent.path("settlementId").asText()).isEqualTo(refunded.text("id"));
        assertThat(refundEvent.path("kind").asText()).isEqualTo("REFUND");
        assertThat(refundEvent.path("commissionMinor").asLong()).isZero();
    }

    @Test
    void replayingASettlementDoesNotPublishItAgain() {
        String buyer = newUser(), store = newStore(), order = newOrder(), marker = newOrder();
        topUp(buyer, 2_000);
        payOrder(buyer, store, order, 1_000);
        payOrder(buyer, store, marker, 1_000);
        String key = newKey();
        release(order, key, 0, null);
        awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(order));

        release(order, key, 0, null);                                              // same key: a replay, nothing new happens
        release(marker, newKey(), 0, null);
        awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(marker));

        assertThat(countOf("settlement.completed", b -> b.path("orderId").asText().equals(order))).isEqualTo(1);
    }

    // ------------------------------------------------------------------ the shared fixtures (contracts/events)
    @Test
    void messagesOnTheBrokerHaveTheShapeOfTheSharedFixtures() {
        String alice = newUser(), bob = newUser(), store = newStore();
        String paidOrder = newOrder(), releasedOrder = newOrder(), refundedOrder = newOrder();
        topUp(alice, 20_000);
        Response p2p = post("/api/v1/transfer-intents", as(alice),
                Map.of("toUserId", bob, "amountMinor", 2_500, "note", "lunch", "reference", Map.of("type", "chat", "id", "room-1")));
        String p2pIntent = p2p.text("id");
        confirm(alice, p2pIntent);
        String orderIntent = payOrder(alice, store, paidOrder, 5_000);
        payOrder(alice, store, releasedOrder, 4_000);
        payOrder(alice, store, refundedOrder, 2_000);
        release(releasedOrder, newKey(), 400, null);
        refund(refundedOrder, newKey(), null);

        assertSameShape("transfer.completed.p2p", awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(p2pIntent)).body());
        assertSameShape("transfer.completed.order-payment", awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(orderIntent)).body());
        assertSameShape("settlement.completed.release", awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(releasedOrder)).body());
        assertSameShape("settlement.completed.refund", awaitEvent("settlement.completed", b -> b.path("orderId").asText().equals(refundedOrder)).body());
    }

    private void assertSameShape(String fixture, JsonNode actual) {
        assertThat(Contracts.shapeDifferences(Contracts.load(fixture), actual)).as("%s versus the message on the broker", fixture).isEmpty();
    }

    // ------------------------------------------------------------------ correlation ids
    private Response confirmWithCorrelationId(String user, String intentId, String correlationId) {
        try {
            MockHttpServletResponse response = mvc.perform(MockMvcRequestBuilders.post("/api/v1/transfer-intents/" + intentId + "/confirm")
                    .header("Authorization", "Bearer " + as(user)).header("X-Correlation-Id", correlationId)).andReturn().getResponse();
            assertThat(response.getHeader("X-Correlation-Id")).as("the response echoes the id").isEqualTo(correlationId);
            return new Response(response.getStatus(), json.readTree(response.getContentAsString()));
        } catch (Exception e) {
            throw new IllegalStateException("confirm failed", e);
        }
    }

    @Test
    void theCorrelationIdOfTheRequestTravelsOnTheMessageAndInsideIt() {
        String alice = newUser(), bob = newUser();
        String correlationId = "it-corr-" + UUID.randomUUID().toString().substring(0, 8);
        topUp(alice, 5_000);
        String intentId = createIntent(alice, bob, 700, "traced").text("id");

        Response confirmed = confirmWithCorrelationId(alice, intentId, correlationId);
        Received event = awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(intentId));

        assertThat(confirmed.status()).isEqualTo(200);
        assertThat(event.headers()).as("AMQP header").containsEntry("x-correlation-id", correlationId);
        assertThat(event.body().path("correlationId").asText()).as("stored with the event itself").isEqualTo(correlationId);
    }

    @Test
    void aRequestWithoutAnIdGetsOneAndTheEventCarriesThatSameId() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        String intentId = createIntent(alice, bob, 300, "untraced").text("id");

        Received event = null;
        try {
            MockHttpServletResponse response = mvc.perform(MockMvcRequestBuilders.post("/api/v1/transfer-intents/" + intentId + "/confirm")
                    .header("Authorization", "Bearer " + as(alice))).andReturn().getResponse();
            String generated = response.getHeader("X-Correlation-Id");
            event = awaitEvent("transfer.completed", b -> b.path("intentId").asText().equals(intentId));
            assertThat(generated).matches("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
            assertThat(event.headers()).containsEntry("x-correlation-id", generated);
        } catch (Exception e) {
            throw new IllegalStateException("confirm failed", e);
        }
    }
}
