package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.transfer.internal.TransferDtos.CreateIntentRequest;
import com.chatpay.wallet.transfer.internal.TransferDtos.IntentView;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/transfer-intents")
class TransferIntentController {

    private final TransferIntentService service;

    TransferIntentController(TransferIntentService service) {
        this.service = service;
    }

    @PostMapping
    ResponseEntity<IntentView> create(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateIntentRequest request) {
        return ResponseEntity.status(201).body(service.create(jwt.getSubject(), request));
    }

    @GetMapping
    List<IntentView> list(@AuthenticationPrincipal Jwt jwt,
                          @RequestParam(defaultValue = "false") boolean open,
                          @RequestParam(defaultValue = "20") int limit) {
        return open ? service.listOpen(jwt.getSubject()) : service.listRecent(jwt.getSubject(), limit);
    }

    @GetMapping("/{id}")
    IntentView one(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return service.get(jwt.getSubject(), id);
    }

    /**
     * 200 means "this payment is completed", whether it was just now or on an earlier call.
     * Anything else is a 409 with the intent's real state, so a client can never mistake it for success.
     */
    @PostMapping("/{id}/confirm")
    ResponseEntity<?> confirm(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        IntentView view = service.confirm(jwt.getClaimAsString("iss"), jwt.getSubject(), id);
        if ("COMPLETED".equals(view.status())) {
            return ResponseEntity.ok(view);
        }
        return ResponseEntity.status(409).body(Map.of(
                "code", "INTENT_" + view.status(),
                "message", "This payment is " + view.status().toLowerCase() + " and can no longer be confirmed",
                "intent", view));
    }

    @PostMapping("/{id}/cancel")
    IntentView cancel(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return service.cancel(jwt.getSubject(), id);
    }
}
