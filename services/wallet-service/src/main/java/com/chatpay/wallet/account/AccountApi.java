package com.chatpay.wallet.account;

import java.util.Optional;
import java.util.UUID;

/**
 * PUBLIC API of the account module. Maps an external identity (issuer + subject,
 * i.e. who Keycloak says you are) to an internal wallet account id. This mapping
 * is what lets a second system with a different IdP reuse the wallet later.
 */
public interface AccountApi {

    /** Creates the wallet on first use (race-safe). */
    AccountView getOrCreateUserAccount(String issuer, String subject);

    /**
     * Platform-owned accounts such as "escrow" or "platform-revenue". Only "treasury" (dev money source) and
     * "adjustments" (finance corrections) may go negative in the ledger; every other system account may not.
     */
    AccountView getOrCreateSystemAccount(String name);

    /** A vendor's own business wallet, kept apart from its owner's personal wallet. */
    AccountView getOrCreateStoreAccount(String storeId);

    Optional<AccountView> findUserAccount(String issuer, String subject);

    Optional<AccountView> findById(UUID accountId);
}
