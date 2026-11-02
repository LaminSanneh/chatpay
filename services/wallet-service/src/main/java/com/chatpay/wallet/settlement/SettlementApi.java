package com.chatpay.wallet.settlement;

import java.util.UUID;

/**
 * PUBLIC API of the settlement module (order escrow). The transfer module calls this in the same
 * transaction that moves an order payment into escrow, so "money is in escrow" and "the order has a hold"
 * can never disagree.
 */
public interface SettlementApi {

    void recordHold(String orderId, String payerUserId, UUID payerAccountId, String storeId,
                    long amountMinor, String currency, UUID transferId);
}
