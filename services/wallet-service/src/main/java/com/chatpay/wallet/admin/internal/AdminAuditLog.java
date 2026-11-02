package com.chatpay.wallet.admin.internal;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Who did what, when. Insert-only (also enforced by a database trigger). */
@Entity
@Table(name = "admin_audit_log")
public class AdminAuditLog {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false) private String actor;
    @Column(name = "actor_name") private String actorName;
    @Column(nullable = false, length = 64) private String action;
    @Column(name = "target_type", length = 32) private String targetType;
    @Column(name = "target_id", length = 128) private String targetId;
    @Column(columnDefinition = "text") private String detail;
    @Column(name = "created_at", nullable = false) private Instant createdAt;

    protected AdminAuditLog() {}

    AdminAuditLog(String actor, String actorName, String action, String targetType, String targetId, String detail) {
        this.actor = actor;
        this.actorName = actorName;
        this.action = action;
        this.targetType = targetType;
        this.targetId = targetId;
        this.detail = detail;
        this.createdAt = Instant.now();
    }
}
