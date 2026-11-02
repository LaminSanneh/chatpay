package com.chatpay.wallet.admin.internal;

import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface AdminActionRepository extends JpaRepository<AdminAction, UUID> {

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select a from AdminAction a where a.id = :id")
    Optional<AdminAction> findByIdForUpdate(@Param("id") UUID id);

    List<AdminAction> findByStatusOrderByCreatedAtDesc(AdminAction.Status status, Pageable pageable);

    boolean existsByTransferIdAndTypeAndStatusIn(UUID transferId, AdminAction.Type type, Collection<AdminAction.Status> statuses);
}
