package com.chatpay.wallet;

import com.chatpay.wallet.support.WalletIntegrationTest;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.stream.IntStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Money under contention, against the real database: the row locks and constraints must hold when requests arrive at the same moment.
 * Each test fires its requests together and then checks the invariants that must survive any interleaving.
 */
@Timeout(180)
class ConcurrencyIT extends WalletIntegrationTest {

    @Test
    void twentyParallelConfirmsOfOneIntentCreateExactlyOneTransfer() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        String intentId = createIntent(alice, bob, 2_500, "race").text("id");

        List<Response> results = runInParallel(IntStream.range(0, 20)
                .mapToObj(i -> (Callable<Response>) () -> confirm(alice, intentId)).toList());

        assertThat(results).extracting(Response::status).containsOnly(200);
        assertThat(results).extracting(r -> r.text("status")).containsOnly("COMPLETED");
        assertThat(results.stream().map(r -> r.text("transferId")).distinct().count()).as("everyone sees the same transfer").isEqualTo(1);
        UUID transferId = UUID.fromString(results.get(0).text("transferId"));
        assertThat(count("select count(*) from transfer where intent_id = ?", UUID.fromString(intentId))).isEqualTo(1);
        assertThat(count("select count(*) from ledger_entry where transaction_id = ?", transferId)).as("one debit and one credit").isEqualTo(2);
        assertThat(balance(alice)).isEqualTo(7_500);
        assertThat(balance(bob)).isEqualTo(2_500);
        assertBooksReconcile();
    }

    @Test
    void fiftyParallelPaymentsFromOneAccountNeverOverdrawIt() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        List<String> intents = IntStream.range(0, 50).mapToObj(i -> createIntent(alice, bob, 500, "p" + i).text("id")).toList();

        List<Response> results = runInParallel(intents.stream().map(id -> (Callable<Response>) () -> confirm(alice, id)).toList());

        long paid = results.stream().filter(r -> r.status() == 200).count();
        long refused = results.stream().filter(r -> r.status() == 422 && r.code().equals("INSUFFICIENT_FUNDS")).count();
        assertThat(paid).as("10,000 covers exactly 20 payments of 500").isEqualTo(20);
        assertThat(refused).isEqualTo(30);
        assertThat(balance(alice)).isZero();
        assertThat(balance(bob)).isEqualTo(10_000);
        assertThat(count("select count(*) from transfer where from_user_id = ?", alice)).isEqualTo(20);
        assertThat(count("select count(*) from ledger_account where balance_minor < 0 and not allow_negative")).as("nobody overdrawn").isZero();
        assertBooksReconcile();
    }

    @Test
    void crossingPaymentsBetweenTwoPeopleDoNotDeadlock() {
        String alice = newUser(), bob = newUser();
        topUp(alice, 10_000);
        topUp(bob, 10_000);
        List<Callable<Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            String aliceToBob = createIntent(alice, bob, 100, "a" + i).text("id");
            String bobToAlice = createIntent(bob, alice, 100, "b" + i).text("id");
            tasks.add(() -> confirm(alice, aliceToBob));
            tasks.add(() -> confirm(bob, bobToAlice));
        }

        List<Response> results = runInParallel(tasks);    // a deadlock would fail here after 90 seconds

        assertThat(results).extracting(Response::status).containsOnly(200);
        assertThat(balance(alice)).isEqualTo(10_000);
        assertThat(balance(bob)).isEqualTo(10_000);
        assertBooksReconcile();
    }

    @Test
    void manyPeoplePayingANewcomerAtOnceCreateExactlyOneWalletForThem() {
        String newcomer = newUser();
        List<Callable<Response>> tasks = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            String payer = newUser();
            topUp(payer, 1_000);
            String intentId = createIntent(payer, newcomer, 300, "welcome").text("id");
            tasks.add(() -> confirm(payer, intentId));
        }

        List<Response> results = runInParallel(tasks);

        assertThat(results).extracting(Response::status).containsOnly(200);
        assertThat(count("select count(*) from account where owner_subject = ?", newcomer)).as("one wallet, not ten").isEqualTo(1);
        assertThat(count("select count(*) from ledger_account where account_id in (select id from account where owner_subject = ?)", newcomer))
                .isEqualTo(1);
        assertThat(balance(newcomer)).isEqualTo(3_000);
        assertBooksReconcile();
    }
}