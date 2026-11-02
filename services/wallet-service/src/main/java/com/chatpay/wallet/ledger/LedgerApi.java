package com.chatpay.wallet.ledger;

import java.util.List;
import java.util.UUID;

/**
 * PUBLIC API of the ledger module. Other modules may depend on this package and
 * nothing deeper. The ledger knows accounts only as opaque ids: it has no idea
 * about users, transfers, chats or orders.
 */
public interface LedgerApi {

    /** Idempotent. Call once when an account is created. */
    void openAccount(UUID accountId, String currency, boolean allowNegative);

    long balance(UUID accountId);

    /**
     * Atomically records a balanced transaction. Entries are append-only: this is the only way money moves,
     * and a mistake is corrected by posting a new, opposite transaction. Must run inside the caller's
     * transaction so business state and money move together.
     */
    void post(LedgerTransaction transaction);

    /** Newest first. Pass the previous page's `nextBefore` as `beforeSeq` to go further back. */
    EntriesPage entries(UUID accountId, Long beforeSeq, int limit);

    /** Accounts whose cached balance does not match their entries. Empty means the books are consistent. */
    List<Discrepancy> reconcile();
}
