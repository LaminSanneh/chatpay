package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.shared.Correlation;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.ledger.LedgerApi;
import com.chatpay.wallet.ledger.LedgerKinds;
import com.chatpay.wallet.ledger.LedgerTransaction;
import com.chatpay.wallet.ledger.Posting;
import com.chatpay.wallet.settlement.SettlementApi;
import com.chatpay.wallet.shared.DomainException;
import com.chatpay.wallet.transfer.TransferCompleted;
import com.chatpay.wallet.transfer.internal.TransferDtos.CreateIntentRequest;
import com.chatpay.wallet.transfer.internal.TransferDtos.IntentView;
import com.chatpay.wallet.transfer.internal.TransferDtos.MerchantIntentRequest;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.data.domain.PageRequest;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * SERVER-ISSUED TRANSFER INTENTS: how every payment happens.
 *
 *   1. CREATE   NO MONEY MOVES. Two ways to create one:
 *                 P2P   POST /api/v1/transfer-intents           the payer asks to pay another user
 *                 ORDER POST /api/v1/internal/transfer-intents  the STORE BACKEND (service account) asks a customer to pay
 *                       for an order, with a server-computed amount. A client can never set the price of an order.
 *   2. CONFIRM  POST /api/v1/transfer-intents/{id}/confirm, always by the payer, with their own token.
 *               One DB transaction: lock the intent row, check it is still CREATED and not expired, create the
 *               transfer, post the ledger entries, mark the intent COMPLETED, write the outbox event.
 *                 P2P   payer -> recipient
 *                 ORDER payer -> "escrow" (a hold is recorded for the order; released or refunded later)
 *               The intent id is the idempotency key: confirming twice returns the same result and pays once.
 *   3. RECOVER  GET /api/v1/transfer-intents/{id}  or  GET ...?open=true
 *   4. LIFECYCLE  CANCEL by the user, or EXPIRED by timeout (lazily on confirm/read, and by a sweeper).
 *
 * Business failures at confirm time (e.g. INSUFFICIENT_FUNDS) roll the transaction back and leave the intent
 * CREATED, so the user can top up and confirm the same intent again until it expires.
 *
 * NOT BUILT YET: step-up auth (PIN) on confirm, fee quotes, limit/fraud checks, recipient display name on review.
 */
@Service
class TransferIntentService {

    private static final Logger log = LoggerFactory.getLogger(TransferIntentService.class);

    private final TransferIntentRepository intents;
    private final TransferRepository transfers;
    private final AccountApi accounts;       // transfer -> account (public API)
    private final LedgerApi ledger;          // transfer -> ledger  (public API)
    private final SettlementApi settlement;  // transfer -> settlement (public API)
    private final ApplicationEventPublisher events;
    private final String currency;
    private final long ttlSeconds;
    private final long orderTtlSeconds;

    TransferIntentService(TransferIntentRepository intents, TransferRepository transfers, AccountApi accounts,
                          LedgerApi ledger, SettlementApi settlement, ApplicationEventPublisher events,
                          @Value("${wallet.default-currency}") String currency,
                          @Value("${wallet.intent-ttl-seconds}") long ttlSeconds,
                          @Value("${wallet.order-intent-ttl-seconds}") long orderTtlSeconds) {
        this.intents = intents;
        this.transfers = transfers;
        this.accounts = accounts;
        this.ledger = ledger;
        this.settlement = settlement;
        this.events = events;
        this.currency = currency;
        this.ttlSeconds = ttlSeconds;
        this.orderTtlSeconds = orderTtlSeconds;
    }

    /** P2P. The sender is always the authenticated user. Nothing moves yet. */
    @Transactional
    public IntentView create(String userId, CreateIntentRequest req) {
        if (userId.equals(req.toUserId())) {
            throw DomainException.badRequest("SELF_TRANSFER", "You cannot send money to yourself");
        }
        String refType = req.reference() == null ? null : req.reference().type();
        String refId = req.reference() == null ? null : req.reference().id();
        // "order" is reserved for the store backend: otherwise a user could dress up a P2P payment as an order payment.
        if (refType != null && !"chat".equals(refType)) {
            throw DomainException.badRequest("INVALID_REFERENCE", "Clients may only use the reference type 'chat'");
        }
        Instant now = Instant.now();
        TransferIntent intent = intents.save(TransferIntent.p2p(userId, req.toUserId(), req.amountMinor(), currency,
                req.note(), refType, refId, now.plusSeconds(ttlSeconds)));
        return IntentView.of(intent, now);
    }

    /** ORDER. Called by the store backend. Idempotent per order: repeating it returns the live intent. */
    @Transactional
    public IntentView createOrderIntent(String actor, MerchantIntentRequest req) {
        Instant now = Instant.now();
        var existing = intents.findActiveOrder(req.orderId(), List.of(IntentStatus.CREATED, IntentStatus.COMPLETED));
        if (existing.isPresent()) {
            TransferIntent i = existing.get();
            boolean same = i.getFromUserId().equals(req.payerUserId())
                    && i.getAmountMinor() == req.amountMinor()
                    && i.getToUserId().equals("store:" + req.storeId());
            if (!same) {
                throw DomainException.conflict("ORDER_INTENT_MISMATCH", "A payment for this order already exists with different details");
            }
            if (i.getStatus() == IntentStatus.COMPLETED || i.getExpiresAt().isAfter(now)) {
                return IntentView.of(i, now);
            }
            i.markExpired();
            intents.saveAndFlush(i);          // free the unique slot BEFORE inserting the replacement
        }
        TransferIntent created = intents.save(TransferIntent.order(actor, req.payerUserId(), req.storeId(), req.amountMinor(),
                currency, req.note(), req.orderId(), now.plusSeconds(orderTtlSeconds)));
        return IntentView.of(created, now);
    }

    /** Idempotent. Returns the intent's state; the controller turns anything but COMPLETED into a 409. */
    @Transactional
    public IntentView confirm(String issuer, String userId, UUID id) {
        TransferIntent intent = lockOwned(userId, id);
        Instant now = Instant.now();

        if (intent.getStatus() != IntentStatus.CREATED) {
            return IntentView.of(intent, now);           // COMPLETED = replay of the original result
        }
        if (!intent.getExpiresAt().isAfter(now)) {
            intent.markExpired();                          // committed with this transaction
            return IntentView.of(intent, now);
        }

        AccountView from = accounts.getOrCreateUserAccount(issuer, userId);
        long amount = intent.getAmountMinor();
        Transfer t;
        if (intent.isOrder()) {
            AccountView escrow = accounts.getOrCreateSystemAccount("escrow");
            t = transfers.save(new Transfer(from.id(), escrow.id(), userId, intent.getToUserId(), amount, intent.getCurrency(),
                    intent.getNote(), intent.getReferenceType(), intent.getReferenceId(), intent.getId(), "ORDER_PAYMENT"));
            ledger.post(new LedgerTransaction(t.getId(), t.getCurrency(), LedgerKinds.ORDER_PAYMENT,
                    "order " + intent.getReferenceId(), "order", intent.getReferenceId(),
                    List.of(new Posting(from.id(), Direction.DEBIT, amount), new Posting(escrow.id(), Direction.CREDIT, amount))));
            settlement.recordHold(intent.getReferenceId(), userId, from.id(), intent.getStoreId(), amount, t.getCurrency(), t.getId());
        } else {
            AccountView to = accounts.getOrCreateUserAccount(issuer, intent.getToUserId());
            t = transfers.save(new Transfer(from.id(), to.id(), userId, intent.getToUserId(), amount, intent.getCurrency(),
                    intent.getNote(), intent.getReferenceType(), intent.getReferenceId(), intent.getId(), "P2P"));
            ledger.post(new LedgerTransaction(t.getId(), t.getCurrency(), LedgerKinds.TRANSFER, intent.getNote(),
                    "transfer", t.getId().toString(),
                    List.of(new Posting(from.id(), Direction.DEBIT, amount), new Posting(to.id(), Direction.CREDIT, amount))));
        }

        intent.markCompleted(t.getId());

        events.publishEvent(new TransferCompleted(1, t.getId(), intent.getId(), t.getKind(), userId, intent.getToUserId(),
                amount, intent.getCurrency(), intent.getNote(), intent.getReferenceType(), intent.getReferenceId(), Instant.now(),
                Correlation.currentOrNew()));

        return IntentView.of(intent, now);
    }

    @Transactional
    public IntentView cancel(String userId, UUID id) {
        TransferIntent intent = lockOwned(userId, id);
        if (intent.getStatus() == IntentStatus.COMPLETED) {
            throw DomainException.conflict("INTENT_COMPLETED", "This payment was already completed and cannot be cancelled");
        }
        if (intent.getStatus() == IntentStatus.CREATED) {
            intent.markCancelled();
        }
        return IntentView.of(intent, Instant.now());      // CANCELLED / EXPIRED stay as they are
    }

    @Transactional(readOnly = true)
    public IntentView get(String userId, UUID id) {
        TransferIntent intent = intents.findById(id)
                .filter(i -> i.getFromUserId().equals(userId))
                .orElseThrow(() -> notFound());
        return IntentView.of(intent, Instant.now());
    }

    /** Intents the user can still confirm: the recovery list after a refresh or device switch. */
    @Transactional(readOnly = true)
    public List<IntentView> listOpen(String userId) {
        Instant now = Instant.now();
        return intents.findOpen(userId, IntentStatus.CREATED, now, PageRequest.of(0, 20)).stream()
                .map(i -> IntentView.of(i, now)).toList();
    }

    @Transactional(readOnly = true)
    public List<IntentView> listRecent(String userId, int limit) {
        Instant now = Instant.now();
        int size = Math.max(1, Math.min(limit, 100));
        return intents.findByFromUserIdOrderByCreatedAtDesc(userId, PageRequest.of(0, size)).stream()
                .map(i -> IntentView.of(i, now)).toList();
    }

    /** Housekeeping only: correctness never depends on it, because expiry is also checked on every read/confirm. */
    @Scheduled(fixedDelayString = "${wallet.intent-sweep-interval-ms:60000}")
    @Transactional
    public void expireStale() {
        int n = intents.expireStale(IntentStatus.CREATED, IntentStatus.EXPIRED, Instant.now());
        if (n > 0) log.info("Expired {} stale transfer intents", n);
    }

    private TransferIntent lockOwned(String userId, UUID id) {
        return intents.findByIdForUpdate(id)
                .filter(i -> i.getFromUserId().equals(userId))
                .orElseThrow(() -> notFound());           // same answer for "missing" and "not yours"
    }

    private static DomainException notFound() {
        return DomainException.notFound("INTENT_NOT_FOUND", "Payment not found");
    }
}
