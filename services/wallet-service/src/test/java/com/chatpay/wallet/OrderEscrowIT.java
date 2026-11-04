package com.chatpay.wallet;

import com.chatpay.wallet.support.OrderWalletIntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Order payments end to end inside the wallet: merchant-created intent -> buyer pays into ESCROW -> the store backend releases
 * (store gets the money minus commission) or refunds (buyer gets it back). Escrow, store and revenue balances are read from the
 * database as deltas because those system accounts are shared by every test.
 */
@Timeout(180)
class OrderEscrowIT extends OrderWalletIntegrationTest {

    // ------------------------------------------------------------------ creating the payment
    @Test
    void aMerchantCreatedOrderPaymentMovesNothingYet() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 20_000);

        Response intent = createOrderIntent(buyer, store, order, 5_000);

        assertThat(intent.text("kind")).isEqualTo("ORDER");
        assertThat(intent.text("status")).isEqualTo("CREATED");
        assertThat(intent.text("fromUserId")).isEqualTo(buyer);
        assertThat(intent.text("toUserId")).isEqualTo("store:" + store);
        assertThat(intent.text("referenceType")).isEqualTo("order");
        assertThat(intent.text("referenceId")).isEqualTo(order);
        assertThat(intent.number("amountMinor")).isEqualTo(5_000);
        assertThat(balance(buyer)).isEqualTo(20_000);
        assertThat(count("select count(*) from order_escrow where order_id = ?", order)).isZero();
    }

    @Test
    void askingAgainForTheSameOrderReturnsTheSameLivePayment() {
        String buyer = newUser(), store = newStore(), order = newOrder();

        String first = createOrderIntent(buyer, store, order, 5_000).text("id");
        String second = createOrderIntent(buyer, store, order, 5_000).text("id");

        assertThat(second).isEqualTo(first);
        assertThat(count("select count(*) from transfer_intent where kind = 'ORDER' and reference_id = ?", order)).isEqualTo(1);
    }

    @Test
    void changingTheDetailsOfALivePaymentIsRefused() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        createOrderIntent(buyer, store, order, 5_000);

        Response otherAmount = orderIntent(buyer, store, order, 6_000);
        Response otherBuyer = orderIntent(newUser(), store, order, 5_000);
        Response otherStore = orderIntent(buyer, newStore(), order, 5_000);

        for (Response r : List.of(otherAmount, otherBuyer, otherStore)) {
            assertThat(r.status()).as("%s", r).isEqualTo(409);
            assertThat(r.code()).isEqualTo("ORDER_INTENT_MISMATCH");
        }
    }

    @Test
    void aCancelledPaymentFreesTheOrderForANewOne() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        String first = createOrderIntent(buyer, store, order, 5_000).text("id");
        assertThat(cancel(buyer, first).text("status")).isEqualTo("CANCELLED");

        Response second = createOrderIntent(buyer, store, order, 5_000);

        assertThat(second.text("id")).isNotEqualTo(first);
        assertThat(second.text("status")).isEqualTo("CREATED");
    }

    @Test
    void anExpiredUnpaidPaymentIsReplacedByANewOne() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        String first = createOrderIntent(buyer, store, order, 5_000).text("id");
        jdbc.update("update transfer_intent set expires_at = now() - interval '1 minute' where id = ?", UUID.fromString(first));

        Response second = createOrderIntent(buyer, store, order, 5_000);

        assertThat(second.text("id")).isNotEqualTo(first);
        assertThat(jdbc.queryForObject("select status from transfer_intent where id = ?", String.class, UUID.fromString(first))).isEqualTo("EXPIRED");
    }

    @Test
    void askingAgainAfterItWasPaidReturnsThePaidPayment() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 20_000);
        String paid = payOrder(buyer, store, order, 5_000);

        Response again = createOrderIntent(buyer, store, order, 5_000);

        assertThat(again.text("id")).isEqualTo(paid);
        assertThat(again.text("status")).isEqualTo("COMPLETED");
    }

    // ------------------------------------------------------------------ paying into escrow
    @Test
    void onlyTheBuyerCanPayAndTheMoneyGoesToEscrowNotToTheStore() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 20_000);
        long escrowBefore = systemBalance("escrow");
        String intentId = createOrderIntent(buyer, store, order, 5_000).text("id");

        assertThat(confirm(newUser(), intentId).status()).as("somebody else cannot pay it").isEqualTo(404);
        assertThat(confirm(buyer, intentId).status()).isEqualTo(200);

        assertThat(balance(buyer)).isEqualTo(15_000);
        assertThat(systemBalance("escrow") - escrowBefore).isEqualTo(5_000);
        assertThat(storeBalance(store)).as("the store has not been paid yet").isZero();
        assertThat(jdbc.queryForMap("select payer_user_id, store_id, paid_minor from order_escrow where order_id = ?", order))
                .containsEntry("payer_user_id", buyer).containsEntry("store_id", store).containsEntry("paid_minor", 5_000L);
        assertThat(jdbc.queryForMap("select kind, to_user_id from transfer where intent_id = ?", UUID.fromString(intentId)))
                .containsEntry("kind", "ORDER_PAYMENT").containsEntry("to_user_id", "store:" + store);
        assertThat(count("select count(*) from ledger_entry where kind = 'ORDER_PAYMENT' and reference_type = 'order' and reference_id = ?", order))
                .as("one debit (buyer) and one credit (escrow)").isEqualTo(2);
        assertBooksReconcile();
    }

    @Test
    void notEnoughMoneyLeavesTheOrderUnpaidAndTheSamePaymentCanBeConfirmedLater() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 1_000);
        String intentId = createOrderIntent(buyer, store, order, 5_000).text("id");

        Response refused = confirm(buyer, intentId);

        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("INSUFFICIENT_FUNDS");
        assertThat(count("select count(*) from order_escrow where order_id = ?", order)).isZero();
        assertThat(get("/api/v1/transfer-intents/" + intentId, as(buyer)).text("status")).isEqualTo("CREATED");

        topUp(buyer, 4_000);
        assertThat(confirm(buyer, intentId).status()).isEqualTo(200);
        assertThat(count("select count(*) from order_escrow where order_id = ?", order)).isEqualTo(1);
    }

    // ------------------------------------------------------------------ release
    @Test
    void releaseSplitsTheEscrowBetweenTheStoreAndThePlatform() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 20_000);
        payOrder(buyer, store, order, 10_000);
        long escrowBefore = systemBalance("escrow"), revenueBefore = systemBalance("platform-revenue");

        Response released = release(order, newKey(), 1_000, null);

        assertThat(released.status()).as("%s", released).isEqualTo(200);
        assertThat(released.text("kind")).isEqualTo("RELEASE");
        assertThat(released.number("amountMinor")).isEqualTo(10_000);
        assertThat(released.number("commissionMinor")).isEqualTo(1_000);
        assertThat(released.number("heldAfterMinor")).isZero();
        assertThat(storeBalance(store)).isEqualTo(9_000);
        assertThat(systemBalance("platform-revenue") - revenueBefore).isEqualTo(1_000);
        assertThat(escrowBefore - systemBalance("escrow")).as("everything left escrow").isEqualTo(10_000);
        assertThat(count("select count(*) from ledger_entry where kind = 'SETTLEMENT' and reference_type = 'order' and reference_id = ?", order))
                .as("escrow debit, store credit, revenue credit").isEqualTo(3);
        assertThat(jdbc.queryForObject("select created_by from settlement where order_id = ?", String.class, order))
                .isEqualTo("service-account-laravel-service");
        assertBooksReconcile();
    }

    @Test
    void releasingWithoutCommissionPaysTheStoreEverything() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 5_000);
        payOrder(buyer, store, order, 5_000);
        long revenueBefore = systemBalance("platform-revenue");

        assertThat(release(order, newKey(), 0, null).status()).isEqualTo(200);

        assertThat(storeBalance(store)).isEqualTo(5_000);
        assertThat(systemBalance("platform-revenue")).isEqualTo(revenueBefore);
    }

    @Test
    void escrowCanBeReleasedInInstalmentsUntilNothingIsLeft() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);

        Response first = release(order, newKey(), 400, 4_000L);
        Response second = release(order, newKey(), 600, null);       // everything that is left
        Response third = release(order, newKey(), 0, null);

        assertThat(first.number("heldAfterMinor")).isEqualTo(6_000);
        assertThat(second.number("amountMinor")).isEqualTo(6_000);
        assertThat(second.number("heldAfterMinor")).isZero();
        assertThat(storeBalance(store)).isEqualTo(3_600 + 5_400);
        assertThat(third.status()).isEqualTo(422);
        assertThat(third.code()).isEqualTo("EXCEEDS_HELD");
        assertBooksReconcile();
    }

    @Test
    void impossibleAmountsAreRefusedAndNothingMoves() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 1_000);
        payOrder(buyer, store, order, 1_000);

        Response commissionTooBig = release(order, newKey(), 1_001, null);
        Response moreThanHeld = release(order, newKey(), 0, 1_001L);
        Response zeroAmount = release(order, newKey(), 0, 0L);

        assertThat(commissionTooBig.status()).isEqualTo(400);
        assertThat(commissionTooBig.code()).isEqualTo("INVALID_COMMISSION");
        assertThat(moreThanHeld.status()).isEqualTo(422);
        assertThat(moreThanHeld.code()).isEqualTo("EXCEEDS_HELD");
        assertThat(zeroAmount.status()).isEqualTo(400);
        assertThat(zeroAmount.code()).isEqualTo("VALIDATION_FAILED");
        assertThat(count("select count(*) from settlement where order_id = ?", order)).isZero();
        assertThat(storeBalance(store)).isZero();
    }

    @Test
    void anOrderThatWasNeverPaidCannotBeSettled() {
        String buyer = newUser(), store = newStore(), unknown = newOrder(), unpaid = newOrder();
        createOrderIntent(buyer, store, unpaid, 1_000);

        for (String order : List.of(unknown, unpaid)) {
            Response release = release(order, newKey(), 0, null);
            Response refund = refund(order, newKey(), null);
            assertThat(release.status()).isEqualTo(404);
            assertThat(release.code()).isEqualTo("ORDER_NOT_FUNDED");
            assertThat(refund.status()).isEqualTo(404);
            assertThat(refund.code()).isEqualTo("ORDER_NOT_FUNDED");
        }
    }

    // ------------------------------------------------------------------ idempotency
    @Test
    void repeatingASettlementWithTheSameKeyReturnsTheOriginalAndPaysOnce() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);
        String key = newKey();

        Response first = release(order, key, 1_000, null);
        Response replay = release(order, key, 1_000, null);

        assertThat(replay.status()).isEqualTo(200);
        assertThat(replay.text("id")).isEqualTo(first.text("id"));
        assertThat(storeBalance(store)).isEqualTo(9_000);
        assertThat(count("select count(*) from settlement where order_id = ?", order)).isEqualTo(1);
    }

    @Test
    void aKeyCannotBeReusedForSomethingElse() {
        String buyer = newUser(), store = newStore(), orderA = newOrder(), orderB = newOrder();
        topUp(buyer, 20_000);
        payOrder(buyer, store, orderA, 5_000);
        payOrder(buyer, store, orderB, 5_000);
        String key = newKey();
        release(orderA, key, 0, null);

        Response otherOrder = release(orderB, key, 0, null);
        Response otherKind = refund(orderA, key, null);

        assertThat(otherOrder.status()).isEqualTo(409);
        assertThat(otherOrder.code()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
        assertThat(otherKind.status()).isEqualTo(409);
        assertThat(otherKind.code()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
    }

    @Test
    void aSettlementWithoutAnIdempotencyKeyIsRefused() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 1_000);
        payOrder(buyer, store, order, 1_000);

        Response noKey = post("/api/v1/internal/orders/" + order + "/release", merchant(), Map.of("commissionMinor", 0));

        assertThat(noKey.status()).isEqualTo(400);
        assertThat(count("select count(*) from settlement where order_id = ?", order)).isZero();
    }

    // ------------------------------------------------------------------ refund
    @Test
    void aRefundReturnsTheHeldMoneyToTheBuyer() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);
        assertThat(balance(buyer)).isZero();
        long escrowBefore = systemBalance("escrow");

        Response refunded = refund(order, newKey(), null);

        assertThat(refunded.status()).as("%s", refunded).isEqualTo(200);
        assertThat(refunded.text("kind")).isEqualTo("REFUND");
        assertThat(refunded.number("amountMinor")).isEqualTo(10_000);
        assertThat(refunded.number("commissionMinor")).isZero();
        assertThat(balance(buyer)).isEqualTo(10_000);
        assertThat(storeBalance(store)).isZero();
        assertThat(escrowBefore - systemBalance("escrow")).isEqualTo(10_000);
        assertThat(count("select count(*) from ledger_entry where kind = 'REFUND' and reference_type = 'order' and reference_id = ?", order)).isEqualTo(2);
        assertThat(refund(order, newKey(), null).code()).as("nothing left to refund").isEqualTo("EXCEEDS_HELD");
        assertBooksReconcile();
    }

    @Test
    void aPartialRefundLeavesTheRestForTheStore() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);

        assertThat(refund(order, newKey(), 3_000L).status()).isEqualTo(200);
        Response rest = release(order, newKey(), 700, null);

        assertThat(balance(buyer)).isEqualTo(3_000);
        assertThat(rest.number("amountMinor")).isEqualTo(7_000);
        assertThat(storeBalance(store)).isEqualTo(6_300);
        assertBooksReconcile();
    }

    @Test
    void afterAFullReleaseNothingCanBeRefunded() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 5_000);
        payOrder(buyer, store, order, 5_000);
        release(order, newKey(), 0, null);

        Response refund = refund(order, newKey(), null);

        assertThat(refund.status()).isEqualTo(422);
        assertThat(refund.code()).isEqualTo("EXCEEDS_HELD");
        assertThat(balance(buyer)).isZero();
    }

    // ------------------------------------------------------------------ races
    @Test
    void aReleaseAndARefundRacingForTheSameMoneyHaveExactlyOneWinner() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);
        List<Callable<Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            String releaseKey = newKey(), refundKey = newKey();
            tasks.add(() -> release(order, releaseKey, 0, null));
            tasks.add(() -> refund(order, refundKey, null));
        }

        List<Response> results = runInParallel(tasks);

        List<Response> winners = results.stream().filter(r -> r.status() == 200).toList();
        assertThat(winners).as("exactly one settlement wins").hasSize(1);
        assertThat(results.stream().filter(r -> r.status() == 422 && r.code().equals("EXCEEDS_HELD")).count()).isEqualTo(7);
        assertThat(count("select count(*) from settlement where order_id = ?", order)).isEqualTo(1);
        boolean released = winners.get(0).text("kind").equals("RELEASE");
        assertThat(storeBalance(store)).isEqualTo(released ? 10_000 : 0);
        assertThat(balance(buyer)).isEqualTo(released ? 0 : 10_000);
        assertBooksReconcile();
    }

    @Test
    void tenIdenticalParallelReleasesWithTheSameKeyPayOnce() {
        String buyer = newUser(), store = newStore(), order = newOrder();
        topUp(buyer, 10_000);
        payOrder(buyer, store, order, 10_000);
        String key = newKey();

        List<Response> results = runInParallel(IntStream.range(0, 10)
                .mapToObj(i -> (Callable<Response>) () -> release(order, key, 1_000, null)).toList());

        assertThat(results).extracting(Response::status).containsOnly(200);
        assertThat(results.stream().map(r -> r.text("id")).distinct().count()).isEqualTo(1);
        assertThat(storeBalance(store)).isEqualTo(9_000);
        assertThat(count("select count(*) from settlement where order_id = ?", order)).isEqualTo(1);
        assertBooksReconcile();
    }
}
