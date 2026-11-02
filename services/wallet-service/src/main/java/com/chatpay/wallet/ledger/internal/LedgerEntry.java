package com.chatpay.wallet.ledger.internal;

import com.chatpay.wallet.ledger.Direction;
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

/** Append-only (also enforced by a database trigger). Never update or delete rows. */
@Entity
@Table(name = "ledger_entry")
public class LedgerEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** Assigned by the database (bigserial); read-only here. */
    @Column(name = "seq", insertable = false, updatable = false)
    private Long seq;

    @Column(name = "transaction_id", nullable = false)
    private UUID transactionId;

    @Column(name = "account_id", nullable = false)
    private UUID accountId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 6)
    private Direction direction;

    @Column(name = "amount_minor", nullable = false)
    private long amountMinor;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(length = 255)
    private String description;

    @Column(name = "balance_after")
    private Long balanceAfter;

    @Column(nullable = false, length = 32)
    private String kind;

    @Column(name = "reference_type", length = 64)
    private String referenceType;

    @Column(name = "reference_id", length = 128)
    private String referenceId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected LedgerEntry() {}

    LedgerEntry(UUID transactionId, UUID accountId, Direction direction, long amountMinor, String currency,
                String kind, String description, String referenceType, String referenceId, long balanceAfter) {
        this.transactionId = transactionId;
        this.accountId = accountId;
        this.direction = direction;
        this.amountMinor = amountMinor;
        this.currency = currency;
        this.kind = kind;
        this.description = description;
        this.referenceType = referenceType;
        this.referenceId = referenceId;
        this.balanceAfter = balanceAfter;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public Long getSeq() { return seq; }
    public UUID getTransactionId() { return transactionId; }
    public Direction getDirection() { return direction; }
    public long getAmountMinor() { return amountMinor; }
    public String getCurrency() { return currency; }
    public String getDescription() { return description; }
    public Long getBalanceAfter() { return balanceAfter; }
    public String getKind() { return kind; }
    public String getReferenceType() { return referenceType; }
    public String getReferenceId() { return referenceId; }
    public Instant getCreatedAt() { return createdAt; }
}
