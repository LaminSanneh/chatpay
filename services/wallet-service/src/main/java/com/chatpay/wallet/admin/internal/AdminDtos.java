package com.chatpay.wallet.admin.internal;

import com.chatpay.wallet.ledger.Direction;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

final class AdminDtos {
    private AdminDtos() {}

    public record Actor(String id, String name) {}

    public record AdjustmentRequest(@NotNull UUID accountId, @NotNull Direction direction, @Positive long amountMinor,
                                    @NotBlank @Size(max = 32) String reasonCode, @NotBlank @Size(max = 500) String reason) {}

    public record ReversalRequest(@NotBlank @Size(max = 32) String reasonCode, @NotBlank @Size(max = 500) String reason) {}

    public record DecisionRequest(@Size(max = 500) String note) {}

    public record WalletInfo(UUID accountId, String userId, String currency, long balanceMinor) {}

    public record ActionView(UUID id, String type, String status, UUID accountId, UUID transferId, String direction,
                             long amountMinor, String currency, String reasonCode, String reason,
                             String createdBy, Instant createdAt, String decidedBy, Instant decidedAt,
                             String decisionNote, UUID ledgerTransactionId) {
        static ActionView of(AdminAction a) {
            return new ActionView(a.getId(), a.getType().name(), a.getStatus().name(), a.getAccountId(), a.getTransferId(),
                    a.getDirection() == null ? null : a.getDirection().name(), a.getAmountMinor(), a.getCurrency(),
                    a.getReasonCode(), a.getReason(), a.getCreatedBy(), a.getCreatedAt(), a.getDecidedBy(), a.getDecidedAt(),
                    a.getDecisionNote(), a.getLedgerTransactionId());
        }
    }
}
