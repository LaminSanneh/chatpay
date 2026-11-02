package com.chatpay.wallet.account.internal;

import com.chatpay.wallet.account.AccountType;
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
@Table(name = "account")
public class Account {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(name = "owner_issuer", nullable = false)
    private String ownerIssuer;

    @Column(name = "owner_subject", nullable = false)
    private String ownerSubject;

    @Column(nullable = false, length = 3)
    private String currency;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private AccountType type;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Account() {}

    public UUID getId() { return id; }
    public String getOwnerIssuer() { return ownerIssuer; }
    public String getOwnerSubject() { return ownerSubject; }
    public String getCurrency() { return currency; }
    public AccountType getType() { return type; }
}
