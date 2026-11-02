package com.chatpay.wallet.account.internal;

import com.chatpay.wallet.account.AccountApi;
import com.chatpay.wallet.account.AccountView;
import com.chatpay.wallet.ledger.EntriesPage;
import com.chatpay.wallet.ledger.LedgerApi;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/wallet")
class WalletController {

    public record WalletView(UUID accountId, String userId, String currency, long balanceMinor) {}

    private final AccountApi accounts;
    private final LedgerApi ledger;

    WalletController(AccountApi accounts, LedgerApi ledger) {
        this.accounts = accounts;
        this.ledger = ledger;
    }

    /** The caller's wallet. Created on first call. */
    @GetMapping
    WalletView me(@AuthenticationPrincipal Jwt jwt) {
        AccountView acc = accounts.getOrCreateUserAccount(jwt.getClaimAsString("iss"), jwt.getSubject());
        return new WalletView(acc.id(), jwt.getSubject(), acc.currency(), ledger.balance(acc.id()));
    }

    /** The caller's statement, newest first. Page backwards with `before` = the previous page's `nextBefore`. */
    @GetMapping("/entries")
    EntriesPage entries(@AuthenticationPrincipal Jwt jwt,
                        @RequestParam(required = false) Long before,
                        @RequestParam(defaultValue = "30") int limit) {
        AccountView acc = accounts.getOrCreateUserAccount(jwt.getClaimAsString("iss"), jwt.getSubject());
        return ledger.entries(acc.id(), before, limit);
    }
}
