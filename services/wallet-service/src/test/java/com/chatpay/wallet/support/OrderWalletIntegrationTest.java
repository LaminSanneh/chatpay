package com.chatpay.wallet.support;

import com.fasterxml.jackson.databind.node.MissingNode;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Adds the store-backend side of the wallet to the base class: merchant-created order payments, release and refund
 * (which need an Idempotency-Key header), and direct reads of store and system balances.
 */
public abstract class OrderWalletIntegrationTest extends WalletIntegrationTest {

    protected static String newStore() { return "store-" + UUID.randomUUID(); }

    protected static String newOrder() { return "order-" + UUID.randomUUID(); }

    protected static String newKey() { return "key-" + UUID.randomUUID(); }

    // ------------------------------------------------------------------ merchant calls
    /** POST with an Idempotency-Key header (the base class's call() cannot add headers). */
    protected Response postWithKey(String path, String token, String idempotencyKey, Object body) {
        try {
            MockHttpServletRequestBuilder request = MockMvcRequestBuilders.post(path)
                    .accept(MediaType.APPLICATION_JSON)
                    .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                    .header("Idempotency-Key", idempotencyKey);
            if (body != null) {
                request.contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body));
            }
            MockHttpServletResponse response = mvc.perform(request).andReturn().getResponse();
            String content = response.getContentAsString();
            return new Response(response.getStatus(), content.isBlank() ? MissingNode.getInstance() : json.readTree(content));
        } catch (Exception e) {
            throw new IllegalStateException("request failed: POST " + path, e);
        }
    }

    /** The store backend asks `payerId` to pay for an order. Returns the raw answer (201 with the intent, or an error). */
    protected Response orderIntent(String payerId, String storeId, String orderId, long amountMinor) {
        return post("/api/v1/internal/transfer-intents", merchant(),
                Map.of("payerUserId", payerId, "storeId", storeId, "orderId", orderId, "amountMinor", amountMinor, "note", "order " + orderId));
    }

    protected Response createOrderIntent(String payerId, String storeId, String orderId, long amountMinor) {
        Response r = orderIntent(payerId, storeId, orderId, amountMinor);
        assertThat(r.status()).as("create order intent: %s", r).isEqualTo(201);
        return r;
    }

    /** Creates the order payment and has the buyer confirm it. Returns the intent id. */
    protected String payOrder(String payerId, String storeId, String orderId, long amountMinor) {
        String intentId = createOrderIntent(payerId, storeId, orderId, amountMinor).text("id");
        Response confirmed = confirm(payerId, intentId);
        assertThat(confirmed.status()).as("pay order: %s", confirmed).isEqualTo(200);
        return intentId;
    }

    /** Release escrow to the store. `amountMinor` null = everything still held. */
    protected Response release(String orderId, String idempotencyKey, long commissionMinor, Long amountMinor) {
        Map<String, Object> body = new HashMap<>();
        body.put("commissionMinor", commissionMinor);
        if (amountMinor != null) {
            body.put("amountMinor", amountMinor);
        }
        return postWithKey("/api/v1/internal/orders/" + orderId + "/release", merchant(), idempotencyKey, body);
    }

    /** Refund held money to the buyer. `amountMinor` null = everything still held. */
    protected Response refund(String orderId, String idempotencyKey, Long amountMinor) {
        Object body = amountMinor == null ? null : Map.of("amountMinor", amountMinor);
        return postWithKey("/api/v1/internal/orders/" + orderId + "/refund", merchant(), idempotencyKey, body);
    }

    // ------------------------------------------------------------------ balances read straight from the database
    protected long storeBalance(String storeId) {
        return balanceOfAccount("store", storeId);
    }

    /** "escrow", "platform-revenue", "treasury" or "adjustments". 0 when the account does not exist yet. */
    protected long systemBalance(String name) {
        return balanceOfAccount("system", name);
    }

    private long balanceOfAccount(String ownerIssuer, String ownerSubject) {
        Long value = jdbc.query(
                "select la.balance_minor from ledger_account la join account a on a.id = la.account_id "
                        + "where a.owner_issuer = ? and a.owner_subject = ?",
                rs -> rs.next() ? rs.getLong(1) : 0L, ownerIssuer, ownerSubject);
        return value == null ? 0 : value;
    }
}
