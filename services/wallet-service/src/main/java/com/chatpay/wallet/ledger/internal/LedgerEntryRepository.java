package com.chatpay.wallet.ledger.internal;

import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

interface LedgerEntryRepository extends JpaRepository<LedgerEntry, UUID> {

    List<LedgerEntry> findByAccountIdOrderBySeqDesc(UUID accountId, Pageable pageable);

    List<LedgerEntry> findByAccountIdAndSeqLessThanOrderBySeqDesc(UUID accountId, Long seq, Pageable pageable);
}
