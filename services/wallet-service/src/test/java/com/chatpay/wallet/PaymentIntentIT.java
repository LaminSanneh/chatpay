package com.chatpay.wallet;

import com.chatpay.wallet.support.WalletIntegrationTest;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.assertj.core.api.Assertions.assertThat;

/** The life of a person-to-person payment: create, confirm, recover, expire, cancel, and every way it can be refused. */
@Timeout(180)
class PaymentIntentIT extends WalletIntegrationTest {

    private long transfersByIntent(String intentId) {
        return count("select count(*) from transfer where intent_id = ?", UUID.fromString(intentId));
    }

    private List<String> openIntentIds(String user) {
        Response r = get("/api/v1/transfer-intents?open=true", as(user));
        assertThat(r.status()).isEqualTo(200);
        List<String> ids = new ArrayList<>();
        r.body().forEach((JsonNode n) -> ids.add(n.path("id").asText()));
        return ids;
    }

    @Test
    void creatingAnIntentMovesNoMoneyAndTouchesNoAccount() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);

        Response intent = createIntent(alice, bob, 2_500, "lunch");

        assertThat(intent.text("status")).isEqualTo("CREATED");
        assertThat(intent.text("kind")).isEqualTo("P2P");
        assertThat(intent.text("fromUserId")).isEqualTo(alice);
        assertThat(intent.text("toUserId")).isEqualTo(bob);
        assertThat(intent.number("amountMinor")).isEqualTo(2_500);
        assertThat(Instant.parse(intent.text("expiresAt"))).isAfter(Instant.now());
        assertThat(balance(alice)).isEqualTo(10_000);
        assertThat(count("select count(*) from account where owner_subject = ?", bob)).as("recipient wallet not created yet").isZero();
        assertThat(count("select count(*) from transfer where from_user_id = ?", alice)).isZero();
    }

    @Test
    void confirmingMovesTheMoneyOnceAndLeavesAStatementWithRunningBalances() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        String intentId = createIntent(alice, bob, 2_500, "lunch").text("id");

        Response confirmed = confirm(alice, intentId);

        assertThat(confirmed.status()).isEqualTo(200);
        assertThat(confirmed.text("status")).isEqualTo("COMPLETED");
        assertThat(confirmed.text("transferId")).isNotBlank();
        assertThat(balance(alice)).isEqualTo(7_500);
        assertThat(balance(bob)).isEqualTo(2_500);

        Response transfers = get("/api/v1/transfers", as(alice));
        assertThat(transfers.body().size()).isEqualTo(1);
        assertThat(transfers.body().get(0).path("intentId").asText()).isEqualTo(intentId);
        assertThat(transfers.body().get(0).path("kind").asText()).isEqualTo("P2P");
        assertThat(transfers.body().get(0).path("amountMinor").asLong()).isEqualTo(2_500);

        JsonNode aliceStatement = get("/api/v1/wallet/entries?limit=10", as(alice)).body().path("items");      // newest first
        assertThat(aliceStatement.get(0).path("kind").asText()).isEqualTo("TRANSFER");
        assertThat(aliceStatement.get(0).path("direction").asText()).isEqualTo("DEBIT");
        assertThat(aliceStatement.get(0).path("balanceAfter").asLong()).isEqualTo(7_500);
        assertThat(aliceStatement.get(1).path("kind").asText()).isEqualTo("TOPUP");
        assertThat(aliceStatement.get(1).path("balanceAfter").asLong()).isEqualTo(10_000);

        JsonNode bobStatement = get("/api/v1/wallet/entries?limit=10", as(bob)).body().path("items");
        assertThat(bobStatement.get(0).path("direction").asText()).isEqualTo("CREDIT");
        assertThat(bobStatement.get(0).path("balanceAfter").asLong()).isEqualTo(2_500);
        assertBooksReconcile();
    }

    @Test
    void confirmingTwiceChargesOnce() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        String intentId = createIntent(alice, bob, 2_500, "once").text("id");

        Response first = confirm(alice, intentId);
        Response second = confirm(alice, intentId);

        assertThat(first.status()).isEqualTo(200);
        assertThat(second.status()).isEqualTo(200);
        assertThat(second.text("transferId")).isEqualTo(first.text("transferId"));
        assertThat(balance(alice)).isEqualTo(7_500);
        assertThat(transfersByIntent(intentId)).isEqualTo(1);
    }

    @Test
    void nobodyElseCanSeeConfirmOrCancelSomeonesIntent() {
        String alice = newUser(), bob = newUser(), mallory = newUser();
        topUp(alice, 10_000);
        String intentId = createIntent(alice, bob, 1_000, "private").text("id");

        assertThat(confirm(mallory, intentId).status()).isEqualTo(404);
        assertThat(confirm(mallory, intentId).code()).isEqualTo("INTENT_NOT_FOUND");
        assertThat(cancel(mallory, intentId).status()).isEqualTo(404);
        assertThat(get("/api/v1/transfer-intents/" + intentId, as(mallory)).status()).isEqualTo(404);
        assertThat(get("/api/v1/transfer-intents/" + intentId, as(alice)).status()).isEqualTo(200);
        assertThat(balance(alice)).isEqualTo(10_000);
    }

    @Test
    void insufficientFundsRollsEverythingBackAndTheSameIntentCanBeConfirmedAfterTopUp() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 1_000);
        String intentId = createIntent(alice, bob, 5_000, "too much").text("id");
        long aliceEntries = count("select count(*) from ledger_entry e join account a on a.id = e.account_id where a.owner_subject = ?", alice);

        Response refused = confirm(alice, intentId);

        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("INSUFFICIENT_FUNDS");
        assertThat(balance(alice)).isEqualTo(1_000);
        assertThat(transfersByIntent(intentId)).as("no transfer row survives the rollback").isZero();
        assertThat(count("select count(*) from ledger_entry e join account a on a.id = e.account_id where a.owner_subject = ?", alice))
                .as("no ledger entries survive the rollback").isEqualTo(aliceEntries);
        assertThat(count("select count(*) from account where owner_subject = ?", bob)).as("recipient wallet creation rolled back too").isZero();
        assertThat(get("/api/v1/transfer-intents/" + intentId, as(alice)).text("status")).isEqualTo("CREATED");

        topUp(alice, 4_000);
        Response retried = confirm(alice, intentId);

        assertThat(retried.status()).isEqualTo(200);
        assertThat(balance(alice)).isEqualTo(0);
        assertThat(balance(bob)).isEqualTo(5_000);
        assertBooksReconcile();
    }

    @Test
    void anExpiredIntentCannotBeConfirmedAndIsReportedAsExpired() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        String intentId = createIntent(alice, bob, 1_000, "late").text("id");
        jdbc.update("update transfer_intent set expires_at = now() - interval '1 minute' where id = ?", UUID.fromString(intentId));

        Response first = confirm(alice, intentId);

        assertThat(first.status()).isEqualTo(409);
        assertThat(first.code()).isEqualTo("INTENT_EXPIRED");
        assertThat(get("/api/v1/transfer-intents/" + intentId, as(alice)).text("status")).isEqualTo("EXPIRED");
        assertThat(confirm(alice, intentId).status()).isEqualTo(409);
        assertThat(balance(alice)).isEqualTo(5_000);
        assertThat(transfersByIntent(intentId)).isZero();
    }

    @Test
    void aCancelledIntentCannotBeConfirmed_andCancellingIsRepeatable() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        String intentId = createIntent(alice, bob, 1_000, "changed my mind").text("id");

        assertThat(cancel(alice, intentId).text("status")).isEqualTo("CANCELLED");
        Response confirmed = confirm(alice, intentId);

        assertThat(confirmed.status()).isEqualTo(409);
        assertThat(confirmed.code()).isEqualTo("INTENT_CANCELLED");
        assertThat(cancel(alice, intentId).status()).as("cancelling twice is harmless").isEqualTo(200);
        assertThat(balance(alice)).isEqualTo(5_000);
    }

    @Test
    void aCompletedPaymentCannotBeCancelled() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        String intentId = createIntent(alice, bob, 1_000, "done").text("id");
        confirm(alice, intentId);

        Response cancelled = cancel(alice, intentId);

        assertThat(cancelled.status()).isEqualTo(409);
        assertThat(cancelled.code()).isEqualTo("INTENT_COMPLETED");
        assertThat(balance(bob)).isEqualTo(1_000);
    }

    @Test
    void invalidRequestsAreRefusedBeforeAnythingIsRecorded() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        long before = count("select count(*) from transfer_intent where from_user_id = ?", alice);

        Response self = post("/api/v1/transfer-intents", as(alice), Map.of("toUserId", alice, "amountMinor", 100));
        Response zero = post("/api/v1/transfer-intents", as(alice), Map.of("toUserId", bob, "amountMinor", 0));
        Response negative = post("/api/v1/transfer-intents", as(alice), Map.of("toUserId", bob, "amountMinor", -5));
        Response noRecipient = post("/api/v1/transfer-intents", as(alice), Map.of("toUserId", "", "amountMinor", 100));
        Response orderReference = post("/api/v1/transfer-intents", as(alice),
                Map.of("toUserId", bob, "amountMinor", 100, "reference", Map.of("type", "order", "id", "order-1")));

        assertThat(self.status()).isEqualTo(400);
        assertThat(self.code()).isEqualTo("SELF_TRANSFER");
        assertThat(zero.status()).isEqualTo(400);
        assertThat(zero.code()).isEqualTo("VALIDATION_FAILED");
        assertThat(negative.status()).isEqualTo(400);
        assertThat(noRecipient.status()).isEqualTo(400);
        assertThat(orderReference.status()).isEqualTo(400);
        assertThat(orderReference.code()).as("'order' is reserved for the store backend").isEqualTo("INVALID_REFERENCE");
        assertThat(count("select count(*) from transfer_intent where from_user_id = ?", alice)).isEqualTo(before);
    }

    @Test
    void chatReferencesAreKeptOnTheIntentAndTheTransfer() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 5_000);
        Response intent = post("/api/v1/transfer-intents", as(alice),
                Map.of("toUserId", bob, "amountMinor", 700, "note", "pizza", "reference", Map.of("type", "chat", "id", "room-42")));
        assertThat(intent.status()).isEqualTo(201);
        assertThat(intent.text("referenceType")).isEqualTo("chat");
        assertThat(intent.text("referenceId")).isEqualTo("room-42");

        confirm(alice, intent.text("id"));

        JsonNode transfer = get("/api/v1/transfers", as(bob)).body().get(0);
        assertThat(transfer.path("referenceType").asText()).isEqualTo("chat");
        assertThat(transfer.path("referenceId").asText()).isEqualTo("room-42");
        assertThat(transfer.path("note").asText()).isEqualTo("pizza");
    }

    @Test
    void openIntentsAreListedForRecoveryUntilTheyAreFinished() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        String a = createIntent(alice, bob, 100, "a").text("id");
        String b = createIntent(alice, bob, 200, "b").text("id");
        String c = createIntent(alice, bob, 300, "c").text("id");
        jdbc.update("update transfer_intent set expires_at = now() - interval '1 minute' where id = ?", UUID.fromString(c));

        assertThat(openIntentIds(alice)).as("expired intents are not open").containsExactlyInAnyOrder(a, b);
        confirm(alice, a);
        assertThat(openIntentIds(alice)).containsExactly(b);
        cancel(alice, b);
        assertThat(openIntentIds(alice)).isEmpty();
        assertThat(openIntentIds(bob)).as("the recipient has nothing to confirm").isEmpty();
    }
}