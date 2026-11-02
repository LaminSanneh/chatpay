package com.chatpay.wallet.transfer;

import java.time.Instant;
import java.util.UUID;

/** Immutable snapshot of a completed transfer for other modules (e.g. admin). They never see the entity. */
public record TransferInfo(UUID id, UUID intentId, String kind, UUID fromAccountId, UUID toAccountId,
                           String fromUserId, String toUserId, long amountMinor, String currency, String note, Instant createdAt) {}
