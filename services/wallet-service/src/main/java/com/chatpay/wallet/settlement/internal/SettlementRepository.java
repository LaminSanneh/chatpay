package com.chatpay.wallet.settlement.internal;

import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface SettlementRepository extends JpaRepository<Settlement, UUID> {

    Optional<Settlement> findByIdempotencyKey(String idempotencyKey);

    @Query("select coalesce(sum(s.amountMinor), 0) from Settlement s where s.orderId = :orderId")
    long totalSettled(@Param("orderId") String orderId);
}
