package com.chatpay.wallet.account.internal;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface AccountRepository extends JpaRepository<Account, UUID> {

    Optional<Account> findByOwnerIssuerAndOwnerSubjectAndCurrency(String issuer, String subject, String currency);

    /** ON CONFLICT makes concurrent first-use requests safe without exception juggling. */
    @Modifying
    @Query(value = """
        insert into account (id, owner_issuer, owner_subject, currency, type, created_at)
        values (gen_random_uuid(), :issuer, :subject, :currency, :type, now())
        on conflict (owner_issuer, owner_subject, currency) do nothing
        """, nativeQuery = true)
    int insertIfAbsent(@Param("issuer") String issuer, @Param("subject") String subject,
                       @Param("currency") String currency, @Param("type") String type);
}
