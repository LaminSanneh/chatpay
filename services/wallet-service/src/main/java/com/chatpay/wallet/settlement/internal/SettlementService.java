package com.chatpay.wallet.settlement.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.ledger.LedgerApi;
import com.chatpay.wallet.ledger.LedgerKinds;
import com.chatpay.wallet.ledger.LedgerTransaction;
import com.chatpay.wallet.ledger.Posting;
import com.chatpay.wallet.settlement.SettlementApi;
import com.chatpay.wallet.settlement.SettlementCompleted;
import com.chatpay.wallet.settlement.internal.SettlementDtos.SettlementView;
import com.chatpay.wallet.shared.DomainException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Money held for an order leaves escrow in exactly two ways, both append-only and idempotent:
 *   RELEASE: escrow -> store account (minus the platform's commission, which goes to "platform-revenue")
 *   REFUND:  escrow -> the buyer's account
 * Every call needs an Idempotency-Key from the caller (e.g. "order-123-release"): repeating it returns the original result.
 * Not built yet: refunding AFTER a release (that must pull money back from the store account).
 */
@Service
class SettlementService implements SettlementApi {

    private final OrderEscrowRepository escrows;
    private final SettlementRepository settlements;
    private final AccountApi accounts;
    private final LedgerApi ledger;
    private final ApplicationEventPublisher events;

    SettlementService(OrderEscrowRepository escrows, SettlementRepository settlements, AccountApi accounts,
                      LedgerApi ledger, ApplicationEventPublisher events) {
        this.escrows = escrows;
        this.settlements = settlements;
        this.accounts = accounts;
        this.ledger = ledger;
        this.events = events;
    }

    @Override
    @Transactional
    public void recordHold(String orderId, String payerUserId, UUID payerAccountId, String storeId,
                           long amountMinor, String currency, UUID transferId) {
        escrows.save(new OrderEscrow(orderId, payerUserId, payerAccountId, storeId, amountMinor, currency, transferId));
    }

    @Transactional
    public SettlementView release(String actor, String orderId, String idempotencyKey, Long amountMinor, long commissionMinor) {
        return settle(actor, orderId, idempotencyKey, "RELEASE", amountMinor, commissionMinor);
    }

    @Transactional
    public SettlementView refund(String actor, String orderId, String idempotencyKey, Long amountMinor) {
        return settle(actor, orderId, idempotencyKey, "REFUND", amountMinor, 0);
    }

    private SettlementView settle(String actor, String orderId, String key, String kind, Long requested, long commission) {
        if (key == null || key.isBlank() || key.length() > 128) {
            throw DomainException.badRequest("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1-128 characters");
        }
        // Lock first, then check the key: concurrent identical calls queue up and the second one replays.
        OrderEscrow escrow = escrows.findByIdForUpdate(orderId)
                .orElseThrow(() -> DomainException.notFound("ORDER_NOT_FUNDED", "No payment is held for this order"));

        var replay = settlements.findByIdempotencyKey(key);
        if (replay.isPresent()) {
            Settlement s = replay.get();
            if (!s.getOrderId().equals(orderId) || !s.getKind().equals(kind)) {
                throw DomainException.conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used for a different settlement");
            }
            return view(s, escrow.getPaidMinor() - settlements.totalSettled(orderId));
        }

        long held = escrow.getPaidMinor() - settlements.totalSettled(orderId);
        long amount = requested == null ? held : requested;
        if (amount <= 0 || amount > held) {
            throw DomainException.unprocessable("EXCEEDS_HELD", "Only " + held + " is still held for this order");
        }
        if (commission > amount) {
            throw DomainException.badRequest("INVALID_COMMISSION", "Commission cannot exceed the released amount");
        }

        AccountView escrowAccount = accounts.getOrCreateSystemAccount("escrow");
        List<Posting> postings = new ArrayList<>();
        postings.add(new Posting(escrowAccount.id(), Direction.DEBIT, amount));
        String ledgerKind;
        if (kind.equals("RELEASE")) {
            ledgerKind = LedgerKinds.SETTLEMENT;
            if (amount - commission > 0) {
                postings.add(new Posting(accounts.getOrCreateStoreAccount(escrow.getStoreId()).id(), Direction.CREDIT, amount - commission));
            }
            if (commission > 0) {
                postings.add(new Posting(accounts.getOrCreateSystemAccount("platform-revenue").id(), Direction.CREDIT, commission));
            }
        } else {
            ledgerKind = LedgerKinds.REFUND;
            postings.add(new Posting(escrow.getPayerAccountId(), Direction.CREDIT, amount));
        }

        UUID ledgerTx = UUID.randomUUID();
        ledger.post(new LedgerTransaction(ledgerTx, escrow.getCurrency(), ledgerKind, kind.toLowerCase() + " for order " + orderId,
                "order", orderId, postings));

        Settlement saved = settlements.save(new Settlement(orderId, kind, amount, commission, key, ledgerTx, actor));
        events.publishEvent(new SettlementCompleted(1, saved.getId(), orderId, kind, escrow.getStoreId(), escrow.getPayerUserId(),
                amount, commission, escrow.getCurrency(), Instant.now()));
        return view(saved, held - amount);
    }

    private static SettlementView view(Settlement s, long heldAfter) {
        return new SettlementView(s.getId(), s.getOrderId(), s.getKind(), s.getAmountMinor(), s.getCommissionMinor(), heldAfter, s.getCreatedAt());
    }
}
