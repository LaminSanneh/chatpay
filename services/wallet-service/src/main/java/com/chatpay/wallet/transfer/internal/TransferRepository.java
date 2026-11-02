package com.chatpay.wallet.transfer.internal;

import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

interface TransferRepository extends JpaRepository<Transfer, UUID> {

    @Query("select t from Transfer t where t.fromUserId = :uid or t.toUserId = :uid order by t.createdAt desc")
    List<Transfer> findForUser(@Param("uid") String userId, Pageable pageable);
}
