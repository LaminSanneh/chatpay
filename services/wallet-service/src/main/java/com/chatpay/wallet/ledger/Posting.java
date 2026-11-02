package com.chatpay.wallet.ledger;

import java.util.UUID;

/** One leg of a double-entry transaction. Amounts are in minor units (butut for GMD). */
public record Posting(UUID accountId, Direction direction, long amountMinor) {}
