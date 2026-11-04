package com.chatpay.wallet;

import com.chatpay.wallet.support.OrderWalletIntegrationTest;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The rules about money that must hold no matter what the application does: they are enforced by the database (triggers and
 * constraints) or are arithmetic identities of the ledger. Each test builds some realistic activity first, then checks.
 */
@Timeout(180)
class LedgerInvariantsIT extends OrderWalletIntegrationTest {

    /** Everything one test needs to know about the activity it created. */
    private record World(String alice, String bob, String store, String order, String aliceToBobTransferId) {}

    /** Top-ups, payments both ways, an order that is partly released and partly refunded, and an approved admin correction. */
    private World activity() {
        String alice = newUser(), bob = newUser(), store = newStore(), order = newOrder();
        topUp(alice, 50_000);
        topUp(bob, 5_000);
        pay(alice, bob, 3_000);
        String transferId = get("/api/v1/transfers", as(alice)).body().get(0).path("id").asText();
        pay(bob, alice, 500);
        payOrder(alice, store, order, 8_000);
        assertThat(release(order, newKey(), 800, 5_000L).status()).isEqualTo(200);
        assertThat(refund(order, newKey(), 1_000L).status()).isEqualTo(200);                // 2,000 is still held

        String bobAccount = get("/api/v1/wallet", as(bob)).text("accountId");
        String action = post("/api/v1/admin/adjustments", admin(newUser()),
                Map.of("accountId", bobAccount, "direction", "CREDIT", "amountMinor", 100, "reasonCode", "TEST", "reason", "activity")).text("id");
        assertThat(post("/api/v1/admin/actions/" + action + "/approve", admin(newUser()), Map.of("note", "ok")).status()).isEqualTo(200);
        return new World(alice, bob, store, order, transferId);
    }

    // ------------------------------------------------------------------ append-only
    @Test
    void historyCannotBeEditedOrDeleted_theDatabaseRefuses() {
        activity();
        Map<String, String> updates = Map.of(
                "ledger_entry", "update ledger_entry set amount_minor = amount_minor",
                "transfer", "update transfer set note = note",
                "order_escrow", "update order_escrow set paid_minor = paid_minor",
                "settlement", "update settlement set amount_minor = amount_minor",
                "admin_audit_log", "update admin_audit_log set action = action");

        updates.forEach((table, update) -> {
            long rows = count("select count(*) from " + table);
            assertThat(rows).as("%s has rows to protect", table).isPositive();
            assertThatThrownBy(() -> jdbc.update(update)).as("UPDATE on %s", table).hasMessageContaining("append-only");
            assertThatThrownBy(() -> jdbc.update("delete from " + table)).as("DELETE on %s", table).hasMessageContaining("append-only");
            assertThat(count("select count(*) from " + table)).as("%s is intact", table).isEqualTo(rows);
        });
    }

    // ------------------------------------------------------------------ arithmetic identities
    @Test
    void everyLedgerTransactionIsBalanced() {
        activity();

        long unbalanced = count("select count(*) from (select transaction_id from ledger_entry group by transaction_id "
                + "having sum(case when direction = 'CREDIT' then amount_minor else -amount_minor end) <> 0) t");

        assertThat(unbalanced).as("transactions whose debits differ from their credits").isZero();
    }

    @Test
    void eachAccountsCachedBalanceEqualsTheSumOfItsEntries() {
        World w = activity();

        for (String user : new String[] {w.alice(), w.bob()}) {
            Long summed = jdbc.queryForObject(
                    "select coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0) "
                            + "from ledger_entry e join account a on a.id = e.account_id where a.owner_subject = ?", Long.class, user);
            assertThat(balance(user)).as("balance of %s", user).isEqualTo(summed);
        }
        assertBooksReconcile();
    }

    @Test
    void theStatementIsAnUnbrokenChainOfRunningBalances() {
        World w = activity();

        JsonNode items = get("/api/v1/wallet/entries?limit=100", as(w.alice())).body().path("items");      // newest first
        long expectedAfter = balance(w.alice());
        long lastSeq = Long.MAX_VALUE;
        assertThat(items.size()).isGreaterThanOrEqualTo(4);
        for (JsonNode e : items) {
            assertThat(e.path("balanceAfter").asLong()).as("entry %s", e.path("seq").asLong()).isEqualTo(expectedAfter);
            assertThat(e.path("seq").asLong()).as("entries are strictly ordered").isLessThan(lastSeq);
            lastSeq = e.path("seq").asLong();
            long amount = e.path("amountMinor").asLong();
            expectedAfter += e.path("direction").asText().equals("CREDIT") ? -amount : amount;           // walk backwards in time
        }
        assertThat(expectedAfter).as("the account started at zero").isZero();
    }

    @Test
    void aTransferHasExactlyItsTwoMatchingEntries() {
        World w = activity();
        UUID transferId = UUID.fromString(w.aliceToBobTransferId());

        var entries = jdbc.queryForList(
                "select e.direction, e.amount_minor, a.owner_subject, e.kind from ledger_entry e join account a on a.id = e.account_id where e.transaction_id = ? order by e.direction",
                transferId);

        assertThat(entries).hasSize(2);
        assertThat(entries).extracting(m -> m.get("direction")).containsExactlyInAnyOrder("DEBIT", "CREDIT");
        assertThat(entries).extracting(m -> ((Number) m.get("amount_minor")).longValue()).containsOnly(3_000L);
        assertThat(entries).extracting(m -> m.get("kind")).containsOnly("TRANSFER");
        assertThat(entries).filteredOn(m -> m.get("direction").equals("DEBIT")).extracting(m -> m.get("owner_subject")).containsExactly(w.alice());
        assertThat(entries).filteredOn(m -> m.get("direction").equals("CREDIT")).extracting(m -> m.get("owner_subject")).containsExactly(w.bob());
    }

    @Test
    void whatIsStillHeldForAnOrderEqualsWhatEscrowReallyHoldsForIt() {
        World w = activity();

        Long paid = jdbc.queryForObject("select paid_minor from order_escrow where order_id = ?", Long.class, w.order());
        Long settled = jdbc.queryForObject("select coalesce(sum(amount_minor), 0) from settlement where order_id = ?", Long.class, w.order());
        Long escrowMovement = jdbc.queryForObject(
                "select coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0) "
                        + "from ledger_entry e join account a on a.id = e.account_id "
                        + "where a.owner_issuer = 'system' and a.owner_subject = 'escrow' and e.reference_type = 'order' and e.reference_id = ?",
                Long.class, w.order());

        assertThat(paid - settled).as("held according to the order's own records").isEqualTo(2_000);
        assertThat(escrowMovement).as("held according to the ledger").isEqualTo(paid - settled);
    }

    // ------------------------------------------------------------------ constraints
    @Test
    void onlyTreasuryAndAdjustmentsMayEverGoNegative() {
        activity();

        assertThat(count("select count(*) from ledger_account la join account a on a.id = la.account_id "
                + "where la.allow_negative and not (a.owner_issuer = 'system' and a.owner_subject in ('treasury', 'adjustments'))")).isZero();
        assertThat(count("select count(*) from ledger_account where balance_minor < 0 and not allow_negative")).isZero();
    }

    @Test
    void anOrdinaryBalanceCannotBeForcedNegativeAndAnEntryCannotHaveNoAmount() {
        World w = activity();
        UUID account = jdbc.queryForObject("select id from account where owner_subject = ?", UUID.class, w.alice());

        assertThatThrownBy(() -> jdbc.update("update ledger_account set balance_minor = -1 where account_id = ?", account))
                .hasMessageContaining("ck_balance_non_negative");
        assertThatThrownBy(() -> jdbc.update(
                "insert into ledger_entry (transaction_id, account_id, direction, amount_minor, currency, kind) values (?, ?, 'CREDIT', 0, 'GMD', 'TRANSFER')",
                UUID.randomUUID(), account)).hasMessageContaining("amount_minor");
        assertThat(balance(w.alice())).isPositive();
    }

    @Test
    void everyEntryIsInTheCurrencyOfItsAccount() {
        activity();

        assertThat(count("select count(*) from ledger_entry e join ledger_account a on a.account_id = e.account_id where e.currency <> a.currency")).isZero();
    }
}
