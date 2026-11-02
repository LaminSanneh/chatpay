package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.ledger.LedgerApi;
import com.chatpay.wallet.ledger.LedgerKinds;
import com.chatpay.wallet.ledger.LedgerTransaction;
import com.chatpay.wallet.ledger.Posting;
import com.chatpay.wallet.shared.DomainException;
import com.chatpay.wallet.transfer.TransferApi;
import com.chatpay.wallet.transfer.TransferInfo;
import com.chatpay.wallet.transfer.internal.TransferDtos.TransferView;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Read side of completed transfers, plus the dev top-up. Money moves only via TransferIntentService.confirm. */
@Service
class TransferService implements TransferApi {

    private final TransferRepository transfers;
    private final AccountApi accounts;
    private final LedgerApi ledger;

    TransferService(TransferRepository transfers, AccountApi accounts, LedgerApi ledger) {
        this.transfers = transfers;
        this.accounts = accounts;
        this.ledger = ledger;
    }

    @Transactional(readOnly = true)
    public List<TransferView> listForUser(String userId, int limit) {
        int size = Math.max(1, Math.min(limit, 100));
        return transfers.findForUser(userId, PageRequest.of(0, size)).stream().map(TransferView::of).toList();
    }

    @Transactional(readOnly = true)
    public TransferView getForUser(String userId, UUID id) {
        Transfer t = transfers.findById(id).orElseThrow(() -> DomainException.notFound("TRANSFER_NOT_FOUND", "Transfer not found"));
        if (!t.getFromUserId().equals(userId) && !t.getToUserId().equals(userId)) {
            throw DomainException.notFound("TRANSFER_NOT_FOUND", "Transfer not found");   // do not leak existence
        }
        return TransferView.of(t);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<TransferInfo> find(UUID id) {
        return transfers.findById(id).map(TransferService::info);
    }

    @Override
    @Transactional(readOnly = true)
    public List<TransferInfo> recentForUser(String userId, int limit) {
        int size = Math.max(1, Math.min(limit, 100));
        return transfers.findForUser(userId, PageRequest.of(0, size)).stream().map(TransferService::info).toList();
    }

    /** DEV ONLY: credits a user from the platform treasury so you can test without a real cash-in. */
    @Transactional
    public long devTopUp(String issuer, String userId, long amountMinor) {
        AccountView treasury = accounts.getOrCreateSystemAccount("treasury");
        AccountView user = accounts.getOrCreateUserAccount(issuer, userId);
        ledger.post(new LedgerTransaction(UUID.randomUUID(), user.currency(), LedgerKinds.TOPUP, "dev top-up", null, null,
                List.of(new Posting(treasury.id(), Direction.DEBIT, amountMinor),
                        new Posting(user.id(), Direction.CREDIT, amountMinor))));
        return ledger.balance(user.id());
    }

    private static TransferInfo info(Transfer t) {
        return new TransferInfo(t.getId(), t.getIntentId(), t.getKind(), t.getFromAccountId(), t.getToAccountId(),
                t.getFromUserId(), t.getToUserId(), t.getAmountMinor(), t.getCurrency(), t.getNote(), t.getCreatedAt());
    }
}
