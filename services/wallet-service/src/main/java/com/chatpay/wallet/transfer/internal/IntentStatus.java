package com.chatpay.wallet.transfer.internal;

/** CREATED -> COMPLETED (money moved) | CANCELLED (user) | EXPIRED (timeout). The last three are terminal. */
public enum IntentStatus { CREATED, COMPLETED, CANCELLED, EXPIRED }
