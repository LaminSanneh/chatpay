package com.chatpay.wallet.account.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.account.AccountType;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.ledger.LedgerApi;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
class AccountService implements AccountApi {

    /** System accounts that are allowed to run negative: they are sources/suspense, not holders of customer money. */
    private static final Set<String> MAY_GO_NEGATIVE = Set.of("treasury", "adjustments");

    private final AccountRepository repo;
    private final LedgerApi ledger;          // allowed: account -> ledger (public API only)
    private final String currency;

    AccountService(AccountRepository repo, LedgerApi ledger, @Value("${wallet.default-currency}") String currency) {
        this.repo = repo;
        this.ledger = ledger;
        this.currency = currency;
    }

    @Override
    @Transactional
    public AccountView getOrCreateUserAccount(String issuer, String subject) {
        return getOrCreate(issuer, subject, AccountType.USER);
    }

    @Override
    @Transactional
    public AccountView getOrCreateSystemAccount(String name) {
        return getOrCreate("system", name, AccountType.SYSTEM);
    }

    @Override
    @Transactional
    public AccountView getOrCreateStoreAccount(String storeId) {
        return getOrCreate("store", storeId, AccountType.STORE);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<AccountView> findById(UUID accountId) {
        return repo.findById(accountId).map(this::view);
    }

    @Override
    @Transactional(readOnly = true)
    public Optional<AccountView> findUserAccount(String issuer, String subject) {
        return repo.findByOwnerIssuerAndOwnerSubjectAndCurrency(issuer, subject, currency).map(this::view);
    }

    private AccountView getOrCreate(String issuer, String subject, AccountType type) {
        Optional<Account> existing = repo.findByOwnerIssuerAndOwnerSubjectAndCurrency(issuer, subject, currency);
        if (existing.isPresent()) return view(existing.get());

        int inserted = repo.insertIfAbsent(issuer, subject, currency, type.name());
        Account account = repo.findByOwnerIssuerAndOwnerSubjectAndCurrency(issuer, subject, currency).orElseThrow();
        if (inserted == 1) {
            ledger.openAccount(account.getId(), currency, type == AccountType.SYSTEM && MAY_GO_NEGATIVE.contains(subject));
        }
        return view(account);
    }

    private AccountView view(Account a) {
        return new AccountView(a.getId(), a.getOwnerIssuer(), a.getOwnerSubject(), a.getCurrency(), a.getType());
    }
}
