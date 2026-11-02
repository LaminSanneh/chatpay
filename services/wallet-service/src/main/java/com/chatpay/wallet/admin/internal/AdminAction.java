package com.chatpay.wallet.admin.internal;

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

/** A requested correction. Mutable only along PENDING -> APPROVED | REJECTED; the money effect is appended to the ledger. */
@Entity
@Table(name = "admin_action")
public class AdminAction {

    public enum Type { ADJUSTMENT, REVERSAL }
    public enum Status { PENDING, APPROVED, REJECTED }

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Enumerated(EnumType.STRING) @Column(nullable = false, length = 16) private Type type;
    @Enumerated(EnumType.STRING) @Column(nullable = false, length = 16) private Status status;

    @Column(name = "account_id") private UUID accountId;
    @Column(name = "transfer_id") private UUID transferId;

    @Enumerated(EnumType.STRING) @Column(length = 6) private Direction direction;

    @Column(name = "amount_minor", nullable = false) private long amountMinor;
    @Column(nullable = false, length = 3) private String currency;
    @Column(name = "reason_code", nullable = false, length = 32) private String reasonCode;
    @Column(nullable = false, length = 500) private String reason;
    @Column(name = "created_by", nullable = false) private String createdBy;
    @Column(name = "created_at", nullable = false) private Instant createdAt;
    @Column(name = "decided_by") private String decidedBy;
    @Column(name = "decided_at") private Instant decidedAt;
    @Column(name = "decision_note", length = 500) private String decisionNote;
    @Column(name = "ledger_transaction_id") private UUID ledgerTransactionId;

    protected AdminAction() {}

    static AdminAction adjustment(String createdBy, UUID accountId, Direction direction, long amountMinor, String currency,
                                  String reasonCode, String reason) {
        AdminAction a = new AdminAction(Type.ADJUSTMENT, createdBy, amountMinor, currency, reasonCode, reason);
        a.accountId = accountId;
        a.direction = direction;
        return a;
    }

    static AdminAction reversal(String createdBy, UUID transferId, long amountMinor, String currency, String reasonCode, String reason) {
        AdminAction a = new AdminAction(Type.REVERSAL, createdBy, amountMinor, currency, reasonCode, reason);
        a.transferId = transferId;
        return a;
    }

    private AdminAction(Type type, String createdBy, long amountMinor, String currency, String reasonCode, String reason) {
        this.type = type;
        this.status = Status.PENDING;
        this.createdBy = createdBy;
        this.amountMinor = amountMinor;
        this.currency = currency;
        this.reasonCode = reasonCode;
        this.reason = reason;
        this.createdAt = Instant.now();
    }

    void approve(String by, String note, UUID ledgerTransactionId) {
        this.status = Status.APPROVED;
        this.decidedBy = by;
        this.decidedAt = Instant.now();
        this.decisionNote = note;
        this.ledgerTransactionId = ledgerTransactionId;
    }

    void reject(String by, String note) {
        this.status = Status.REJECTED;
        this.decidedBy = by;
        this.decidedAt = Instant.now();
        this.decisionNote = note;
    }

    public UUID getId() { return id; }
    public Type getType() { return type; }
    public Status getStatus() { return status; }
    public UUID getAccountId() { return accountId; }
    public UUID getTransferId() { return transferId; }
    public Direction getDirection() { return direction; }
    public long getAmountMinor() { return amountMinor; }
    public String getCurrency() { return currency; }
    public String getReasonCode() { return reasonCode; }
    public String getReason() { return reason; }
    public String getCreatedBy() { return createdBy; }
    public Instant getCreatedAt() { return createdAt; }
    public String getDecidedBy() { return decidedBy; }
    public Instant getDecidedAt() { return decidedAt; }
    public String getDecisionNote() { return decisionNote; }
    public UUID getLedgerTransactionId() { return ledgerTransactionId; }
}
