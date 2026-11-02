package com.chatpay.wallet.transfer.internal;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

final class TransferDtos {
    private TransferDtos() {}

    public record Reference(@NotBlank @Size(max = 64) String type, @NotBlank @Size(max = 128) String id) {}

    /** User-created (person to person) intent. The sender is the authenticated user. */
    public record CreateIntentRequest(
            @NotBlank @Size(max = 255) String toUserId,
            @Positive long amountMinor,
            @Size(max = 255) String note,
            @Valid Reference reference) {}

    /** Store-backend-created intent for an order. The amount is computed by the backend, never by the client. */
    public record MerchantIntentRequest(
            @NotBlank @Size(max = 255) String payerUserId,
            @NotBlank @Size(max = 64) String storeId,
            @NotBlank @Size(max = 128) String orderId,
            @Positive long amountMinor,
            @Size(max = 255) String note) {}

    public record TopUpRequest(@Positive long amountMinor) {}

    public record IntentView(UUID id, String kind, String status, String fromUserId, String toUserId, long amountMinor, String currency,
                             String note, String referenceType, String referenceId, UUID transferId,
                             Instant createdAt, Instant expiresAt) {
        /** A CREATED intent past its expiry is reported as EXPIRED even before the sweeper has flipped it. */
        static IntentView of(TransferIntent i, Instant now) {
            IntentStatus effective = i.getStatus() == IntentStatus.CREATED && !i.getExpiresAt().isAfter(now)
                    ? IntentStatus.EXPIRED : i.getStatus();
            return new IntentView(i.getId(), i.getKind(), effective.name(), i.getFromUserId(), i.getToUserId(), i.getAmountMinor(),
                    i.getCurrency(), i.getNote(), i.getReferenceType(), i.getReferenceId(), i.getTransferId(),
                    i.getCreatedAt(), i.getExpiresAt());
        }
    }

    public record TransferView(UUID id, UUID intentId, String kind, String fromUserId, String toUserId, long amountMinor, String currency,
                               String note, String referenceType, String referenceId, String status, Instant createdAt) {
        static TransferView of(Transfer t) {
            return new TransferView(t.getId(), t.getIntentId(), t.getKind(), t.getFromUserId(), t.getToUserId(), t.getAmountMinor(),
                    t.getCurrency(), t.getNote(), t.getReferenceType(), t.getReferenceId(), t.getStatus().name(), t.getCreatedAt());
        }
    }
}
