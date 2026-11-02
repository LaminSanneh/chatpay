package com.chatpay.wallet.admin.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.account.AccountType;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.admin.internal.AdminDtos.ActionView;
import com.chatpay.wallet.admin.internal.AdminDtos.Actor;
import com.chatpay.wallet.admin.internal.AdminDtos.AdjustmentRequest;
import com.chatpay.wallet.admin.internal.AdminDtos.ReversalRequest;
import com.chatpay.wallet.admin.internal.AdminDtos.WalletInfo;
import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.ledger.Discrepancy;
import com.chatpay.wallet.ledger.EntriesPage;
import com.chatpay.wallet.ledger.LedgerApi;
import com.chatpay.wallet.ledger.LedgerKinds;
import com.chatpay.wallet.ledger.LedgerTransaction;
import com.chatpay.wallet.ledger.Posting;
import com.chatpay.wallet.shared.DomainException;
import com.chatpay.wallet.transfer.TransferApi;
import com.chatpay.wallet.transfer.TransferInfo;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Corrections follow strict money rules:
 *   - No endpoint edits or deletes money history. An APPROVED action appends new, opposite ledger entries.
 *   - Four eyes: whoever requested a correction cannot approve it (also enforced by a database constraint).
 *   - Every write is recorded in the append-only admin_audit_log.
 *   - A reversal that cannot be applied (e.g. the recipient already spent the money) rolls back and stays PENDING;
 *     finance then decides on an explicit adjustment instead.
 */
@Service
class AdminService {

    private final AdminActionRepository actions;
    private final AdminAuditRepository audit;
    private final AccountApi accounts;
    private final LedgerApi ledger;
    private final TransferApi transfers;

    AdminService(AdminActionRepository actions, AdminAuditRepository audit, AccountApi accounts, LedgerApi ledger, TransferApi transfers) {
        this.actions = actions;
        this.audit = audit;
        this.accounts = accounts;
        this.ledger = ledger;
        this.transfers = transfers;
    }

    // ---------------- reads ----------------
    /** Looking up a person's wallet is itself audited. */
    @Transactional
    public WalletInfo wallet(Actor actor, String issuer, String userId) {
        AccountView acc = accounts.findUserAccount(issuer, userId)
                .orElseThrow(() -> DomainException.notFound("ACCOUNT_NOT_FOUND", "No wallet for this user"));
        log(actor, "VIEWED_WALLET", "user", userId, null);
        return new WalletInfo(acc.id(), userId, acc.currency(), ledger.balance(acc.id()));
    }

    @Transactional(readOnly = true)
    public EntriesPage entries(UUID accountId, Long before, int limit) {
        accounts.findById(accountId).orElseThrow(() -> DomainException.notFound("ACCOUNT_NOT_FOUND", "Unknown account"));
        return ledger.entries(accountId, before, limit);
    }

    @Transactional(readOnly = true)
    public List<TransferInfo> transfers(String userId, int limit) {
        return transfers.recentForUser(userId, limit);
    }

    @Transactional(readOnly = true)
    public List<Discrepancy> reconciliation() {
        return ledger.reconcile();
    }

    @Transactional(readOnly = true)
    public List<ActionView> actions(AdminAction.Status status, int limit) {
        int size = Math.max(1, Math.min(limit, 100));
        return actions.findByStatusOrderByCreatedAtDesc(status, PageRequest.of(0, size)).stream().map(ActionView::of).toList();
    }

    // ---------------- requests (nothing moves yet) ----------------
    @Transactional
    public ActionView requestAdjustment(Actor actor, AdjustmentRequest req) {
        AccountView account = accounts.findById(req.accountId())
                .orElseThrow(() -> DomainException.notFound("ACCOUNT_NOT_FOUND", "Unknown account"));
        if (account.type() == AccountType.SYSTEM) {
            throw DomainException.unprocessable("NOT_ADJUSTABLE", "System accounts cannot be adjusted directly");
        }
        AdminAction saved = actions.save(AdminAction.adjustment(actor.id(), account.id(), req.direction(), req.amountMinor(),
                account.currency(), req.reasonCode(), req.reason()));
        log(actor, "ADJUSTMENT_REQUESTED", "admin_action", saved.getId().toString(), req.direction() + " " + req.amountMinor() + " on " + account.id());
        return ActionView.of(saved);
    }

    @Transactional
    public ActionView requestReversal(Actor actor, UUID transferId, ReversalRequest req) {
        TransferInfo t = transfers.find(transferId).orElseThrow(() -> DomainException.notFound("TRANSFER_NOT_FOUND", "Transfer not found"));
        if (!"P2P".equals(t.kind())) {
            throw DomainException.unprocessable("NOT_REVERSIBLE", "Order payments are refunded from escrow by the store backend, not reversed here");
        }
        if (actions.existsByTransferIdAndTypeAndStatusIn(transferId, AdminAction.Type.REVERSAL,
                List.of(AdminAction.Status.PENDING, AdminAction.Status.APPROVED))) {
            throw DomainException.conflict("ALREADY_REQUESTED", "A reversal for this transfer is already pending or approved");
        }
        AdminAction saved = actions.save(AdminAction.reversal(actor.id(), transferId, t.amountMinor(), t.currency(), req.reasonCode(), req.reason()));
        log(actor, "REVERSAL_REQUESTED", "transfer", transferId.toString(), req.reasonCode());
        return ActionView.of(saved);
    }

    // ---------------- decisions ----------------
    @Transactional
    public ActionView approve(Actor actor, UUID id, String note) {
        AdminAction action = actions.findByIdForUpdate(id).orElseThrow(() -> DomainException.notFound("ACTION_NOT_FOUND", "Action not found"));
        if (action.getStatus() != AdminAction.Status.PENDING) {
            throw DomainException.conflict("ACTION_NOT_PENDING", "This action is already " + action.getStatus().name().toLowerCase());
        }
        if (action.getCreatedBy().equals(actor.id())) {
            throw new DomainException("FOUR_EYES", 403, "A different admin must approve this action");
        }

        UUID ledgerTx = UUID.randomUUID();
        String description = trim(action.getReasonCode() + ": " + action.getReason());
        if (action.getType() == AdminAction.Type.ADJUSTMENT) {
            AccountView suspense = accounts.getOrCreateSystemAccount("adjustments");
            boolean credit = action.getDirection() == Direction.CREDIT;
            ledger.post(new LedgerTransaction(ledgerTx, action.getCurrency(), LedgerKinds.ADJUSTMENT, description,
                    "admin_action", action.getId().toString(), List.of(
                            new Posting(action.getAccountId(), credit ? Direction.CREDIT : Direction.DEBIT, action.getAmountMinor()),
                            new Posting(suspense.id(), credit ? Direction.DEBIT : Direction.CREDIT, action.getAmountMinor()))));
        } else {
            TransferInfo t = transfers.find(action.getTransferId())
                    .orElseThrow(() -> DomainException.notFound("TRANSFER_NOT_FOUND", "Transfer not found"));
            // The opposite of the original movement. If the recipient no longer has the money, this fails
            // with INSUFFICIENT_FUNDS, rolls back, and the action stays PENDING.
            ledger.post(new LedgerTransaction(ledgerTx, t.currency(), LedgerKinds.REVERSAL, description,
                    "transfer", t.id().toString(), List.of(
                            new Posting(t.toAccountId(), Direction.DEBIT, t.amountMinor()),
                            new Posting(t.fromAccountId(), Direction.CREDIT, t.amountMinor()))));
        }
        action.approve(actor.id(), note, ledgerTx);
        log(actor, "ACTION_APPROVED", "admin_action", id.toString(), note);
        return ActionView.of(action);
    }

    @Transactional
    public ActionView reject(Actor actor, UUID id, String note) {
        AdminAction action = actions.findByIdForUpdate(id).orElseThrow(() -> DomainException.notFound("ACTION_NOT_FOUND", "Action not found"));
        if (action.getStatus() != AdminAction.Status.PENDING) {
            throw DomainException.conflict("ACTION_NOT_PENDING", "This action is already " + action.getStatus().name().toLowerCase());
        }
        action.reject(actor.id(), note);
        log(actor, "ACTION_REJECTED", "admin_action", id.toString(), note);
        return ActionView.of(action);
    }

    private void log(Actor actor, String action, String targetType, String targetId, String detail) {
        audit.save(new AdminAuditLog(actor.id(), actor.name(), action, targetType, targetId, detail));
    }

    private static String trim(String s) {
        return s.length() <= 255 ? s : s.substring(0, 255);
    }
}
