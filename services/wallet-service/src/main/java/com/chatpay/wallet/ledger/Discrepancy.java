package com.chatpay.wallet.ledger;

import java.util.UUID;

/** A ledger account whose cached balance disagrees with the sum of its entries. Should never happen. */
public record Discrepancy(UUID accountId, long cachedBalanceMinor, long computedBalanceMinor) {}
