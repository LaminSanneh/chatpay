package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.transfer.internal.TransferDtos.IntentView;
import com.chatpay.wallet.transfer.internal.TransferDtos.MerchantIntentRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Server-to-server only (role wallet-merchant, enforced in SecurityConfig). The store backend calls this with the
 * price it computed; it returns the intent id, which the customer's app then confirms with the payer's own token.
 */
@RestController
@RequestMapping("/api/v1/internal/transfer-intents")
class InternalIntentController {

    private final TransferIntentService service;

    InternalIntentController(TransferIntentService service) {
        this.service = service;
    }

    @PostMapping
    ResponseEntity<IntentView> createForOrder(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody MerchantIntentRequest request) {
        String client = jwt.getClaimAsString("azp");
        return ResponseEntity.status(201).body(service.createOrderIntent(client != null ? client : jwt.getSubject(), request));
    }
}
