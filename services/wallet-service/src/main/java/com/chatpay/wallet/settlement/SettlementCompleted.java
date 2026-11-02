package com.chatpay.wallet.settlement;

import java.time.Instant;
import java.util.UUID;
import org.springframework.modulith.events.Externalized;

/**
 * PUBLIC EVENT CONTRACT. Sent to RabbitMQ as JSON: exchange "wallet.events", routing key "settlement.completed".
 * kind: RELEASE (escrow -> store, minus commission) or REFUND (escrow -> buyer). Only ADD fields.
 */
@Externalized("wallet.events::settlement.completed")
public record SettlementCompleted(
        int version,
        UUID settlementId,
        String orderId,
        String kind,
        String storeId,
        String payerUserId,
        long amountMinor,
        long commissionMinor,
        String currency,
        Instant occurredAt) {}
