package com.chatpay.wallet.admin.internal;

import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

interface AdminAuditRepository extends JpaRepository<AdminAuditLog, UUID> {}
