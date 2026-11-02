package com.chatpay.wallet.ledger;

/** What a ledger transaction was for. Shown on statements and used for filtering. */
public final class LedgerKinds {
    private LedgerKinds() {}
    public static final String TRANSFER = "TRANSFER";            // person to person
    public static final String TOPUP = "TOPUP";                  // dev top-up (later: real cash-in)
    public static final String ORDER_PAYMENT = "ORDER_PAYMENT";  // buyer -> escrow
    public static final String SETTLEMENT = "SETTLEMENT";        // escrow -> store (+ platform commission)
    public static final String REFUND = "REFUND";                // escrow -> buyer
    public static final String REVERSAL = "REVERSAL";            // admin undoes a transfer (new, opposite entries)
    public static final String ADJUSTMENT = "ADJUSTMENT";        // admin correction (new entries against the suspense account)
}
