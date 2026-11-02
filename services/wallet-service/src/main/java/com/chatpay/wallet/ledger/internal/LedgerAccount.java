package com.chatpay.wallet.ledger.internal;

import com.chatpay.wallet.ledger.Direction;
import com.chatpay.wallet.shared.DomainException;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "ledger_account")
public class LedgerAccount {

    @Id
    @Column(name = "account_id")
    private UUID accountId;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(name = "balance_minor", nullable = false)
    private long balanceMinor;

    @Column(name = "allow_negative", nullable = false)
    private boolean allowNegative;

    protected LedgerAccount() {}

    public UUID getAccountId() { return accountId; }
    public String getCurrency() { return currency; }
    public long getBalanceMinor() { return balanceMinor; }

    void apply(Direction direction, long amountMinor) {
        long next = direction == Direction.CREDIT
                ? Math.addExact(balanceMinor, amountMinor)
                : Math.subtractExact(balanceMinor, amountMinor);
        if (next < 0 && !allowNegative) {
            throw DomainException.unprocessable("INSUFFICIENT_FUNDS", "Insufficient funds");
        }
        this.balanceMinor = next;
    }
}
