package com.chatpay.wallet.ledger.internal;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface LedgerAccountRepository extends JpaRepository<LedgerAccount, UUID> {

    /** Row locks taken in id order, so two transfers between the same accounts can never deadlock. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from LedgerAccount a where a.accountId in :ids order by a.accountId")
    List<LedgerAccount> lockAllOrdered(@Param("ids") Collection<UUID> ids);

    @Modifying
    @Query(value = """
        insert into ledger_account (account_id, currency, balance_minor, allow_negative)
        values (:id, :currency, 0, :allowNegative)
        on conflict (account_id) do nothing
        """, nativeQuery = true)
    int insertIfAbsent(@Param("id") UUID id, @Param("currency") String currency, @Param("allowNegative") boolean allowNegative);
}
