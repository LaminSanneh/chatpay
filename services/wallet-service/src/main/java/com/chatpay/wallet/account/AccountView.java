package com.chatpay.wallet.account;

import java.util.UUID;

/** Immutable snapshot handed to other modules. They never see the JPA entity. */
public record AccountView(UUID id, String ownerIssuer, String ownerSubject, String currency, AccountType type) {}
