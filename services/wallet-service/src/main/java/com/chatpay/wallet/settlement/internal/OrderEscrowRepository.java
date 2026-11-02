package com.chatpay.wallet.settlement.internal;

import jakarta.persistence.LockModeType;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface OrderEscrowRepository extends JpaRepository<OrderEscrow, String> {

    /** Serialises settlements of the same order (two releases, or a release racing a refund). */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select e from OrderEscrow e where e.orderId = :orderId")
    Optional<OrderEscrow> findByIdForUpdate(@Param("orderId") String orderId);
}
