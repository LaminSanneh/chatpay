package com.chatpay.wallet.ledger.internal;

import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.ledger.Discrepancy;
import com.chatpay.wallet.ledger.EntriesPage;
import com.chatpay.wallet.ledger.EntryView;
import com.chatpay.wallet.ledger.LedgerApi;
import com.chatpay.wallet.ledger.LedgerTransaction;
import com.chatpay.wallet.ledger.Posting;
import com.chatpay.wallet.shared.DomainException;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.data.domain.PageRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class LedgerService implements LedgerApi {

    private static final String RECONCILE_SQL = """
        select a.account_id,
               a.balance_minor as cached,
               coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0) as computed
          from ledger_account a
          left join ledger_entry e on e.account_id = a.account_id
         group by a.account_id, a.balance_minor
        having a.balance_minor <> coalesce(sum(case when e.direction = 'CREDIT' then e.amount_minor else -e.amount_minor end), 0)
        """;

    private final LedgerAccountRepository accounts;
    private final LedgerEntryRepository entries;
    private final JdbcTemplate jdbc;

    LedgerService(LedgerAccountRepository accounts, LedgerEntryRepository entries, JdbcTemplate jdbc) {
        this.accounts = accounts;
        this.entries = entries;
        this.jdbc = jdbc;
    }

    @Override
    @Transactional
    public void openAccount(UUID accountId, String currency, boolean allowNegative) {
        accounts.insertIfAbsent(accountId, currency, allowNegative);
    }

    @Override
    @Transactional(readOnly = true)
    public long balance(UUID accountId) {
        return accounts.findById(accountId).map(LedgerAccount::getBalanceMinor).orElse(0L);
    }

    @Override
    @Transactional
    public void post(LedgerTransaction tx) {
        validateBalanced(tx.postings());

        List<UUID> ids = tx.postings().stream().map(Posting::accountId).distinct().sorted().toList();
        Map<UUID, LedgerAccount> locked = accounts.lockAllOrdered(ids).stream()
                .collect(Collectors.toMap(LedgerAccount::getAccountId, Function.identity()));
        if (locked.size() != ids.size()) {
            throw DomainException.notFound("LEDGER_ACCOUNT_NOT_FOUND", "Unknown ledger account");
        }

        for (Posting p : tx.postings()) {
            LedgerAccount account = locked.get(p.accountId());
            if (!account.getCurrency().equals(tx.currency())) {
                throw DomainException.badRequest("CURRENCY_MISMATCH", "Account currency does not match transaction currency");
            }
            account.apply(p.direction(), p.amountMinor());   // dirty-checked and flushed on commit
            entries.save(new LedgerEntry(tx.id(), p.accountId(), p.direction(), p.amountMinor(), tx.currency(),
                    tx.kind(), tx.description(), tx.referenceType(), tx.referenceId(), account.getBalanceMinor()));
        }
    }

    @Override
    @Transactional(readOnly = true)
    public EntriesPage entries(UUID accountId, Long beforeSeq, int limit) {
        int size = Math.max(1, Math.min(limit, 100));
        // fetch one extra row to know whether another page exists
        PageRequest page = PageRequest.of(0, size + 1);
        List<LedgerEntry> rows = beforeSeq == null
                ? entries.findByAccountIdOrderBySeqDesc(accountId, page)
                : entries.findByAccountIdAndSeqLessThanOrderBySeqDesc(accountId, beforeSeq, page);
        boolean more = rows.size() > size;
        List<EntryView> items = rows.stream().limit(size).map(LedgerService::view).toList();
        return new EntriesPage(items, more ? items.get(items.size() - 1).seq() : null);
    }

    @Override
    @Transactional(readOnly = true)
    public List<Discrepancy> reconcile() {
        return jdbc.query(RECONCILE_SQL, (rs, i) -> new Discrepancy(
                rs.getObject("account_id", UUID.class), rs.getLong("cached"), rs.getLong("computed")));
    }

    private static EntryView view(LedgerEntry e) {
        return new EntryView(e.getId(), e.getSeq(), e.getTransactionId(), e.getDirection(), e.getAmountMinor(), e.getCurrency(),
                e.getKind(), e.getDescription(), e.getReferenceType(), e.getReferenceId(), e.getBalanceAfter(), e.getCreatedAt());
    }

    private void validateBalanced(List<Posting> postings) {
        if (postings == null || postings.size() < 2) {
            throw DomainException.badRequest("INVALID_POSTING", "A transaction needs at least two postings");
        }
        long debits = 0, credits = 0;
        for (Posting p : postings) {
            if (p.amountMinor() <= 0) {
                throw DomainException.badRequest("INVALID_POSTING", "Posting amounts must be positive");
            }
            if (p.direction() == Direction.DEBIT) debits = Math.addExact(debits, p.amountMinor());
            else credits = Math.addExact(credits, p.amountMinor());
        }
        if (debits != credits) {
            throw DomainException.badRequest("UNBALANCED", "Debits must equal credits");
        }
    }
}
