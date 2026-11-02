package com.chatpay.wallet.ledger;

import java.time.Instant;
import java.util.UUID;

/** A ledger entry from one account's point of view. `balanceAfter` is null only for entries older than V4. */
public record EntryView(UUID id, long seq, UUID transactionId, Direction direction, long amountMinor, String currency,
                        String kind, String description, String referenceType, String referenceId,
                        Long balanceAfter, Instant createdAt) {}
