package com.chatpay.wallet.settlement.internal;

import com.chatpay.wallet.settlement.internal.SettlementDtos.RefundRequest;
import com.chatpay.wallet.settlement.internal.SettlementDtos.ReleaseRequest;
import com.chatpay.wallet.settlement.internal.SettlementDtos.SettlementView;
import jakarta.validation.Valid;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Server-to-server only (role wallet-merchant, enforced in SecurityConfig). Called by the store backend. */
@RestController
@RequestMapping("/api/v1/internal/orders")
class InternalSettlementController {

    private final SettlementService service;

    InternalSettlementController(SettlementService service) {
        this.service = service;
    }

    /** Delivery confirmed (or the return window ended): pay the store, keep the commission. */
    @PostMapping("/{orderId}/release")
    SettlementView release(@AuthenticationPrincipal Jwt jwt, @PathVariable String orderId,
                           @RequestHeader("Idempotency-Key") String key, @Valid @RequestBody ReleaseRequest request) {
        return service.release(actor(jwt), orderId, key, request.amountMinor(), request.commissionMinor());
    }

    /** Order cancelled or returned while the money is still in escrow: give it back to the buyer. */
    @PostMapping("/{orderId}/refund")
    SettlementView refund(@AuthenticationPrincipal Jwt jwt, @PathVariable String orderId,
                          @RequestHeader("Idempotency-Key") String key, @Valid @RequestBody(required = false) RefundRequest request) {
        return service.refund(actor(jwt), orderId, key, request == null ? null : request.amountMinor());
    }

    private static String actor(Jwt jwt) {
        String client = jwt.getClaimAsString("azp");
        return client != null ? client : jwt.getSubject();
    }
}
