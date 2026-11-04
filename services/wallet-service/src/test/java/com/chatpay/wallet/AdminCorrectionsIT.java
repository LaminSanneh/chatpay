package com.chatpay.wallet;

import com.chatpay.wallet.support.OrderWalletIntegrationTest;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Finance corrections: nothing is edited, a correction is REQUESTED, a DIFFERENT admin approves it, and the effect is new
 * ledger entries. Every write leaves a row in the audit log.
 */
@Timeout(180)
class AdminCorrectionsIT extends OrderWalletIntegrationTest {

    private Response requestReversal(String adminToken, String transferId) {
        return post("/api/v1/admin/transfers/" + transferId + "/reversal", adminToken,
                Map.of("reasonCode", "WRONG_RECIPIENT", "reason", "Sent to the wrong person"));
    }

    private Response requestAdjustment(String adminToken, String accountId, String direction, long amountMinor) {
        return post("/api/v1/admin/adjustments", adminToken,
                Map.of("accountId", accountId, "direction", direction, "amountMinor", amountMinor, "reasonCode", "GOODWILL", "reason", "Customer care gesture"));
    }

    private Response approve(String adminToken, String actionId) {
        return post("/api/v1/admin/actions/" + actionId + "/approve", adminToken, Map.of("note", "checked"));
    }

    private Response reject(String adminToken, String actionId) {
        return post("/api/v1/admin/actions/" + actionId + "/reject", adminToken, Map.of("note", "no"));
    }

    private String accountId(String user) {
        return get("/api/v1/wallet", as(user)).text("accountId");
    }

    private String latestTransferId(String user) {
        return get("/api/v1/transfers", as(user)).body().get(0).path("id").asText();
    }

    private List<String> pendingActionIds(String adminToken) {
        List<String> ids = new ArrayList<>();
        get("/api/v1/admin/actions?status=PENDING", adminToken).body().forEach((JsonNode n) -> ids.add(n.path("id").asText()));
        return ids;
    }

    // ------------------------------------------------------------------ reversals
    @Test
    void aReversalNeedsASecondAdminAndThenReturnsTheMoneyThroughNewEntries() {
        String alice = newUser(), bob = newUser(), first = newUser(), second = newUser();
        topUp(alice, 10_000);
        pay(alice, bob, 2_500);
        String transferId = latestTransferId(alice);

        Response requested = requestReversal(admin(first), transferId);

        assertThat(requested.status()).isEqualTo(201);
        assertThat(requested.text("type")).isEqualTo("REVERSAL");
        assertThat(requested.text("status")).isEqualTo("PENDING");
        assertThat(requested.text("createdBy")).isEqualTo(first);
        assertThat(requested.number("amountMinor")).isEqualTo(2_500);
        assertThat(balance(alice)).as("nothing moves on request").isEqualTo(7_500);
        String actionId = requested.text("id");

        Response self = approve(admin(first), actionId);
        assertThat(self.status()).isEqualTo(403);
        assertThat(self.code()).isEqualTo("FOUR_EYES");
        assertThat(balance(alice)).isEqualTo(7_500);

        Response approved = approve(admin(second), actionId);
        assertThat(approved.status()).as("%s", approved).isEqualTo(200);
        assertThat(approved.text("status")).isEqualTo("APPROVED");
        assertThat(approved.text("decidedBy")).isEqualTo(second);
        assertThat(approved.text("ledgerTransactionId")).isNotBlank();
        assertThat(balance(alice)).isEqualTo(10_000);
        assertThat(balance(bob)).isZero();
        assertThat(count("select count(*) from ledger_entry where kind = 'REVERSAL' and reference_type = 'transfer' and reference_id = ?", transferId))
                .as("the original entries are untouched; two new ones undo them").isEqualTo(2);
        assertThat(count("select count(*) from ledger_entry where transaction_id = ?", UUID.fromString(transferId))).isEqualTo(2);

        assertThat(approve(admin(second), actionId).code()).as("a decided action cannot be decided again").isEqualTo("ACTION_NOT_PENDING");
        assertBooksReconcile();
    }

    @Test
    void aTransferCanOnlyBeReversedOnce() {
        String alice = newUser(), bob = newUser(), admin = newUser();
        topUp(alice, 10_000);
        pay(alice, bob, 1_000);
        String transferId = latestTransferId(alice);
        assertThat(requestReversal(admin(admin), transferId).status()).isEqualTo(201);

        Response again = requestReversal(admin(newUser()), transferId);

        assertThat(again.status()).isEqualTo(409);
        assertThat(again.code()).isEqualTo("ALREADY_REQUESTED");
    }

    @Test
    void ifTheRecipientAlreadySpentTheMoneyTheReversalFailsAndStaysPending_thenItCanBeRejectedAndAskedAgain() {
        String alice = newUser(), bob = newUser(), carol = newUser(), first = newUser(), second = newUser();
        topUp(alice, 10_000);
        pay(alice, bob, 2_000);
        pay(bob, carol, 1_500);                                   // bob keeps only 500
        String transferId = latestTransferId(alice);              // alice's most recent transfer is the one to bob
        String actionId = requestReversal(admin(first), transferId).text("id");

        Response refused = approve(admin(second), actionId);

        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("INSUFFICIENT_FUNDS");
        assertThat(balance(alice)).isEqualTo(8_000);
        assertThat(balance(bob)).isEqualTo(500);
        assertThat(pendingActionIds(admin(second))).contains(actionId);

        assertThat(reject(admin(second), actionId).text("status")).isEqualTo("REJECTED");
        assertThat(approve(admin(second), actionId).code()).isEqualTo("ACTION_NOT_PENDING");
        assertThat(requestReversal(admin(first), transferId).status()).as("a rejected request does not block a new one").isEqualTo(201);
        assertBooksReconcile();
    }

    @Test
    void orderPaymentsAreNotReversedHereTheyAreRefundedFromEscrow() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 5_000);
        payOrder(buyer, store, order, 5_000);
        String transferId = latestTransferId(buyer);

        Response r = requestReversal(admin(newUser()), transferId);

        assertThat(r.status()).isEqualTo(422);
        assertThat(r.code()).isEqualTo("NOT_REVERSIBLE");
    }

    @Test
    void reversingAnUnknownTransferIsA404() {
        Response r = requestReversal(admin(newUser()), UUID.randomUUID().toString());

        assertThat(r.status()).isEqualTo(404);
        assertThat(r.code()).isEqualTo("TRANSFER_NOT_FOUND");
    }

    // ------------------------------------------------------------------ adjustments
    @Test
    void aCreditAdjustmentAddsMoneyOnlyAfterASecondAdminApproves() {
        String user = newUser(), first = newUser(), second = newUser();
        topUp(user, 1_000);
        long adjustmentsBefore = systemBalance("adjustments");
        String actionId = requestAdjustment(admin(first), accountId(user), "CREDIT", 700).text("id");
        assertThat(balance(user)).isEqualTo(1_000);

        Response approved = approve(admin(second), actionId);

        assertThat(approved.status()).isEqualTo(200);
        assertThat(balance(user)).isEqualTo(1_700);
        assertThat(systemBalance("adjustments") - adjustmentsBefore).as("the other side is the suspense account").isEqualTo(-700);
        assertThat(count("select count(*) from ledger_entry where kind = 'ADJUSTMENT' and reference_type = 'admin_action' and reference_id = ?", actionId))
                .isEqualTo(2);
        assertBooksReconcile();
    }

    @Test
    void aDebitAdjustmentLargerThanTheBalanceCannotBeApproved() {
        String user = newUser(), first = newUser(), second = newUser();
        topUp(user, 1_000);
        String actionId = requestAdjustment(admin(first), accountId(user), "DEBIT", 5_000).text("id");

        Response refused = approve(admin(second), actionId);

        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("INSUFFICIENT_FUNDS");
        assertThat(balance(user)).isEqualTo(1_000);
        assertThat(pendingActionIds(admin(second))).contains(actionId);
    }

    @Test
    void invalidAdjustmentRequestsAreRefused() {
        String user = newUser();
        topUp(user, 1_000);
        String treasury = jdbc.queryForObject("select id from account where owner_issuer = 'system' and owner_subject = 'treasury'", String.class);
        String admin = admin(newUser());

        Response systemAccount = requestAdjustment(admin, treasury, "CREDIT", 100);
        Response unknownAccount = requestAdjustment(admin, UUID.randomUUID().toString(), "CREDIT", 100);
        Response zero = requestAdjustment(admin, accountId(user), "CREDIT", 0);
        Response noReason = post("/api/v1/admin/adjustments", admin, Map.of("accountId", accountId(user), "direction", "CREDIT", "amountMinor", 100, "reasonCode", "X"));

        assertThat(systemAccount.status()).isEqualTo(422);
        assertThat(systemAccount.code()).isEqualTo("NOT_ADJUSTABLE");
        assertThat(unknownAccount.status()).isEqualTo(404);
        assertThat(unknownAccount.code()).isEqualTo("ACCOUNT_NOT_FOUND");
        assertThat(zero.status()).isEqualTo(400);
        assertThat(zero.code()).isEqualTo("VALIDATION_FAILED");
        assertThat(noReason.status()).isEqualTo(400);
    }

    // ------------------------------------------------------------------ rules enforced by the database itself
    @Test
    void theDatabaseRefusesToLetTheRequesterBeTheApproverEvenIfTheApplicationWere_Wrong() {
        String user = newUser(), first = newUser();
        topUp(user, 1_000);
        String actionId = requestAdjustment(admin(first), accountId(user), "CREDIT", 100).text("id");

        assertThatThrownBy(() -> jdbc.update("update admin_action set status = 'APPROVED', decided_by = created_by where id = ?", UUID.fromString(actionId)))
                .hasMessageContaining("ck_four_eyes");
    }

    // ------------------------------------------------------------------ audit and inspection
    @Test
    void everyAdminWriteAndWalletLookupIsAudited() {
        String alice = newUser(), bob = newUser(), first = newUser(), second = newUser();
        topUp(alice, 5_000);
        pay(alice, bob, 1_000);
        String actionId = requestReversal(admin(first), latestTransferId(alice)).text("id");
        approve(admin(second), actionId);
        reject(admin(first), requestAdjustment(admin(first), accountId(alice), "CREDIT", 50).text("id"));
        get("/api/v1/admin/users/" + alice + "/wallet", admin(first));

        List<String> firstActions = jdbc.queryForList("select action from admin_audit_log where actor = ?", String.class, first);
        List<String> secondActions = jdbc.queryForList("select action from admin_audit_log where actor = ?", String.class, second);

        assertThat(firstActions).contains("REVERSAL_REQUESTED", "ADJUSTMENT_REQUESTED", "ACTION_REJECTED", "VIEWED_WALLET");
        assertThat(secondActions).containsExactly("ACTION_APPROVED");
        assertThat(jdbc.queryForObject("select target_id from admin_audit_log where actor = ? and action = 'VIEWED_WALLET'", String.class, first)).isEqualTo(alice);
    }

    @Test
    void financeCanInspectAWalletItsTransfersAndItsStatement() {
        String alice = newUser(), bob = newUser(), admin = newUser();
        topUp(alice, 5_000);
        pay(alice, bob, 1_200);

        Response wallet = get("/api/v1/admin/users/" + alice + "/wallet", admin(admin));
        Response transfers = get("/api/v1/admin/users/" + alice + "/transfers", admin(admin));
        Response entries = get("/api/v1/admin/accounts/" + wallet.text("accountId") + "/entries", admin(admin));

        assertThat(wallet.status()).isEqualTo(200);
        assertThat(wallet.number("balanceMinor")).isEqualTo(3_800);
        assertThat(transfers.body().size()).isEqualTo(1);
        assertThat(transfers.body().get(0).path("amountMinor").asLong()).isEqualTo(1_200);
        assertThat(entries.body().path("items").get(0).path("balanceAfter").asLong()).isEqualTo(3_800);
        assertThat(get("/api/v1/admin/users/" + newUser() + "/wallet", admin(admin)).code()).isEqualTo("ACCOUNT_NOT_FOUND");
        assertThat(get("/api/v1/admin/accounts/" + UUID.randomUUID() + "/entries", admin(admin)).code()).isEqualTo("ACCOUNT_NOT_FOUND");
    }

    @Test
    void reconciliationStartsEmptyAndFlagsACorruptedBalance() {
        String user = newUser();
        topUp(user, 1_000);
        assertBooksReconcile();

        // Corrupt the cached balance behind the application's back (ledger_account is the one mutable money table).
        jdbc.update("update ledger_account set balance_minor = balance_minor + 7 where account_id = (select id from account where owner_subject = ?)", user);
        Response broken = get("/api/v1/admin/reconciliation", admin(newUser()));

        assertThat(broken.status()).isEqualTo(200);
        assertThat(broken.body().size()).isEqualTo(1);
        assertThat(broken.body().get(0).path("cachedBalanceMinor").asLong() - broken.body().get(0).path("computedBalanceMinor").asLong()).isEqualTo(7);

        jdbc.update("update ledger_account set balance_minor = balance_minor - 7 where account_id = (select id from account where owner_subject = ?)", user);
        assertBooksReconcile();
    }
}
