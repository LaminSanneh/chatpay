package com.chatpay.wallet.transfer.internal;

import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface TransferIntentRepository extends JpaRepository<TransferIntent, UUID> {

    /** Row lock: two concurrent confirms of the same intent run one after the other, never together. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select i from TransferIntent i where i.id = :id")
    Optional<TransferIntent> findByIdForUpdate(@Param("id") UUID id);

    @Query("select i from TransferIntent i where i.fromUserId = :uid and i.status = :status and i.expiresAt > :now order by i.createdAt desc")
    List<TransferIntent> findOpen(@Param("uid") String userId, @Param("status") IntentStatus status,
                                  @Param("now") Instant now, Pageable pageable);

    /** The live (open or paid) payment intent of an order, if any. Backed by a partial unique index. */
    @Query("select i from TransferIntent i where i.kind = 'ORDER' and i.referenceId = :orderId and i.status in :statuses")
    Optional<TransferIntent> findActiveOrder(@Param("orderId") String orderId, @Param("statuses") Collection<IntentStatus> statuses);

    List<TransferIntent> findByFromUserIdOrderByCreatedAtDesc(String fromUserId, Pageable pageable);

    @Modifying
    @Query("update TransferIntent i set i.status = :expired, i.updatedAt = :now where i.status = :created and i.expiresAt < :now")
    int expireStale(@Param("created") IntentStatus created, @Param("expired") IntentStatus expired, @Param("now") Instant now);
}
