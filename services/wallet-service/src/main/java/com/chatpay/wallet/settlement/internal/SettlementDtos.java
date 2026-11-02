package com.chatpay.wallet.settlement.internal;

import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import java.time.Instant;
import java.util.UUID;

final class SettlementDtos {
    private SettlementDtos() {}

    /** amountMinor omitted = everything still held. commissionMinor is the platform's cut of this release. */
    public record ReleaseRequest(@Positive Long amountMinor, @PositiveOrZero long commissionMinor) {}

    /** amountMinor omitted = everything still held. */
    public record RefundRequest(@Positive Long amountMinor) {}

    public record SettlementView(UUID id, String orderId, String kind, long amountMinor, long commissionMinor,
                                 long heldAfterMinor, Instant createdAt) {}
}
