package com.chatpay.wallet.settlement.internal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** What an order paid into escrow. Insert-only; what is still held = paidMinor - sum(settlements). */
@Entity
@Table(name = "order_escrow")
public class OrderEscrow {

    @Id
    @Column(name = "order_id", length = 128)
    private String orderId;

    @Column(name = "payer_user_id", nullable = false) private String payerUserId;
    @Column(name = "payer_account_id", nullable = false) private UUID payerAccountId;
    @Column(name = "store_id", nullable = false, length = 64) private String storeId;
    @Column(nullable = false, length = 3) private String currency;
    @Column(name = "paid_minor", nullable = false) private long paidMinor;
    @Column(name = "transfer_id", nullable = false) private UUID transferId;
    @Column(name = "created_at", nullable = false) private Instant createdAt;

    protected OrderEscrow() {}

    OrderEscrow(String orderId, String payerUserId, UUID payerAccountId, String storeId, long paidMinor, String currency, UUID transferId) {
        this.orderId = orderId;
        this.payerUserId = payerUserId;
        this.payerAccountId = payerAccountId;
        this.storeId = storeId;
        this.paidMinor = paidMinor;
        this.currency = currency;
        this.transferId = transferId;
        this.createdAt = Instant.now();
    }

    public String getOrderId() { return orderId; }
    public String getPayerUserId() { return payerUserId; }
    public UUID getPayerAccountId() { return payerAccountId; }
    public String getStoreId() { return storeId; }
    public String getCurrency() { return currency; }
    public long getPaidMinor() { return paidMinor; }
}
