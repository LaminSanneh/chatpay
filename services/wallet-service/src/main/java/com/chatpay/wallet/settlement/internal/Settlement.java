package com.chatpay.wallet.settlement.internal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Insert-only (also enforced by a database trigger). */
@Entity
@Table(name = "settlement")
public class Settlement {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "order_id", nullable = false, length = 128) private String orderId;
    @Column(nullable = false, length = 16) private String kind;                    // RELEASE | REFUND
    @Column(name = "amount_minor", nullable = false) private long amountMinor;
    @Column(name = "commission_minor", nullable = false) private long commissionMinor;
    @Column(name = "idempotency_key", nullable = false, length = 128) private String idempotencyKey;
    @Column(name = "ledger_transaction_id", nullable = false) private UUID ledgerTransactionId;
    @Column(name = "created_by", nullable = false) private String createdBy;
    @Column(name = "created_at", nullable = false) private Instant createdAt;

    protected Settlement() {}

    Settlement(String orderId, String kind, long amountMinor, long commissionMinor, String idempotencyKey,
               UUID ledgerTransactionId, String createdBy) {
        this.orderId = orderId;
        this.kind = kind;
        this.amountMinor = amountMinor;
        this.commissionMinor = commissionMinor;
        this.idempotencyKey = idempotencyKey;
        this.ledgerTransactionId = ledgerTransactionId;
        this.createdBy = createdBy;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getOrderId() { return orderId; }
    public String getKind() { return kind; }
    public long getAmountMinor() { return amountMinor; }
    public long getCommissionMinor() { return commissionMinor; }
    public Instant getCreatedAt() { return createdAt; }
}
