package com.chatpay.wallet.transfer.internal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "transfer")
public class Transfer {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "from_account_id", nullable = false) private UUID fromAccountId;
    @Column(name = "to_account_id", nullable = false)   private UUID toAccountId;
    @Column(name = "from_user_id", nullable = false)    private String fromUserId;
    @Column(name = "to_user_id", nullable = false)      private String toUserId;
    @Column(name = "amount_minor", nullable = false)    private long amountMinor;
    @Column(nullable = false, length = 3)               private String currency;
    @Column(length = 255)                               private String note;
    @Column(name = "reference_type", length = 64)       private String referenceType;
    @Column(name = "reference_id", length = 128)        private String referenceId;
    @Column(name = "intent_id")                         private UUID intentId;   // unique in the DB: one intent, one transfer
    @Column(nullable = false, length = 16)              private String kind;     // P2P | ORDER_PAYMENT

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private TransferStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Transfer() {}

    Transfer(UUID fromAccountId, UUID toAccountId, String fromUserId, String toUserId, long amountMinor,
             String currency, String note, String referenceType, String referenceId, UUID intentId, String kind) {
        this.fromAccountId = fromAccountId;
        this.toAccountId = toAccountId;
        this.fromUserId = fromUserId;
        this.toUserId = toUserId;
        this.amountMinor = amountMinor;
        this.currency = currency;
        this.note = note;
        this.referenceType = referenceType;
        this.referenceId = referenceId;
        this.intentId = intentId;
        this.kind = kind;
        this.status = TransferStatus.COMPLETED;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public UUID getFromAccountId() { return fromAccountId; }
    public UUID getToAccountId() { return toAccountId; }
    public UUID getIntentId() { return intentId; }
    public String getKind() { return kind; }
    public String getFromUserId() { return fromUserId; }
    public String getToUserId() { return toUserId; }
    public long getAmountMinor() { return amountMinor; }
    public String getCurrency() { return currency; }
    public String getNote() { return note; }
    public String getReferenceType() { return referenceType; }
    public String getReferenceId() { return referenceId; }
    public TransferStatus getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
}
