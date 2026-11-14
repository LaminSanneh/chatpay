package com.chatpay.wallet.transfer;

import com.chatpay.wallet.shared.CorrelatedEvent;
import java.time.Instant;
import java.util.UUID;
import org.springframework.modulith.events.Externalized;

/**
 * PUBLIC EVENT CONTRACT. Published inside the transfer's DB transaction (stored in the
 * event_publication outbox table) and, after commit, sent to RabbitMQ as JSON:
 * exchange "wallet.events", routing key "transfer.completed".
 *
 * Consumers (chat, ecommerce, notifications...) depend on this shape, so only ADD
 * fields; bump `version` for breaking changes. It carries ids and key facts, not entities.
 *
 * `kind`: P2P (person to person) or ORDER_PAYMENT (buyer -> escrow). Consumers MUST check it: a store backend
 * may only treat an order as paid on kind ORDER_PAYMENT, and chat only shows bubbles for P2P.
 * `referenceType` / `referenceId` are opaque to the wallet (e.g. "chat" / roomId, "order" / orderId).
 */
@Externalized("wallet.events::transfer.completed")
public record TransferCompleted(
        int version,
        UUID transferId,
        UUID intentId,
        String kind,
        String fromUserId,
        String toUserId,
        long amountMinor,
        String currency,
        String note,
        String referenceType,
        String referenceId,
        Instant occurredAt,
        String correlationId) implements CorrelatedEvent {}
