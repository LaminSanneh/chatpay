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

/**
 * kind P2P:   created by the payer; money goes straight to another user.
 * kind ORDER: created by the store backend (server-computed price); money goes to escrow, `toUserId` is "store:<id>".
 */
@Entity
@Table(name = "transfer_intent")
public class TransferIntent {

    public static final String P2P = "P2P";
    public static final String ORDER = "ORDER";

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false, length = 16)           private String kind;
    @Column(name = "created_by")                     private String createdBy;
    @Column(name = "from_user_id", nullable = false) private String fromUserId;
    @Column(name = "to_user_id", nullable = false)   private String toUserId;
    @Column(name = "store_id", length = 64)          private String storeId;
    @Column(name = "amount_minor", nullable = false) private long amountMinor;
    @Column(nullable = false, length = 3)            private String currency;
    @Column(length = 255)                            private String note;
    @Column(name = "reference_type", length = 64)    private String referenceType;
    @Column(name = "reference_id", length = 128)     private String referenceId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private IntentStatus status;

    @Column(name = "transfer_id")                     private UUID transferId;
    @Column(name = "created_at", nullable = false)    private Instant createdAt;
    @Column(name = "updated_at", nullable = false)    private Instant updatedAt;
    @Column(name = "expires_at", nullable = false)    private Instant expiresAt;

    protected TransferIntent() {}

    private TransferIntent(String kind, String createdBy, String fromUserId, String toUserId, String storeId, long amountMinor,
                           String currency, String note, String referenceType, String referenceId, Instant expiresAt) {
        this.kind = kind;
        this.createdBy = createdBy;
        this.fromUserId = fromUserId;
        this.toUserId = toUserId;
        this.storeId = storeId;
        this.amountMinor = amountMinor;
        this.currency = currency;
        this.note = note;
        this.referenceType = referenceType;
        this.referenceId = referenceId;
        this.status = IntentStatus.CREATED;
        this.createdAt = Instant.now();
        this.updatedAt = this.createdAt;
        this.expiresAt = expiresAt;
    }

    static TransferIntent p2p(String payerUserId, String toUserId, long amountMinor, String currency, String note,
                              String referenceType, String referenceId, Instant expiresAt) {
        return new TransferIntent(P2P, payerUserId, payerUserId, toUserId, null, amountMinor, currency, note,
                referenceType, referenceId, expiresAt);
    }

    static TransferIntent order(String createdByService, String payerUserId, String storeId, long amountMinor, String currency,
                                String note, String orderId, Instant expiresAt) {
        return new TransferIntent(ORDER, createdByService, payerUserId, "store:" + storeId, storeId, amountMinor, currency, note,
                "order", orderId, expiresAt);
    }

    boolean isOrder() { return ORDER.equals(kind); }

    void markCompleted(UUID transferId) { this.status = IntentStatus.COMPLETED; this.transferId = transferId; touch(); }
    void markCancelled() { this.status = IntentStatus.CANCELLED; touch(); }
    void markExpired() { this.status = IntentStatus.EXPIRED; touch(); }
    private void touch() { this.updatedAt = Instant.now(); }

    public UUID getId() { return id; }
    public String getKind() { return kind; }
    public String getFromUserId() { return fromUserId; }
    public String getToUserId() { return toUserId; }
    public String getStoreId() { return storeId; }
    public long getAmountMinor() { return amountMinor; }
    public String getCurrency() { return currency; }
    public String getNote() { return note; }
    public String getReferenceType() { return referenceType; }
    public String getReferenceId() { return referenceId; }
    public IntentStatus getStatus() { return status; }
    public UUID getTransferId() { return transferId; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getExpiresAt() { return expiresAt; }
}
