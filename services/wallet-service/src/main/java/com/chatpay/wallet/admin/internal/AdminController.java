package com.chatpay.wallet.admin.internal;

import com.chatpay.wallet.admin.internal.AdminDtos.ActionView;
import com.chatpay.wallet.admin.internal.AdminDtos.Actor;
import com.chatpay.wallet.admin.internal.AdminDtos.AdjustmentRequest;
import com.chatpay.wallet.admin.internal.AdminDtos.DecisionRequest;
import com.chatpay.wallet.admin.internal.AdminDtos.ReversalRequest;
import com.chatpay.wallet.admin.internal.AdminDtos.WalletInfo;
import com.chatpay.wallet.ledger.Discrepancy;
import com.chatpay.wallet.ledger.EntriesPage;
import com.chatpay.wallet.transfer.TransferInfo;
import jakarta.validation.Valid;
import java.util.List;
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

/**
 * Finance operations (role wallet-admin, enforced in SecurityConfig). The Filament back office calls these with the
 * ADMIN'S OWN token, so every action is attributed to a real person. There is deliberately no PUT, PATCH or DELETE on
 * money data: corrections are requested, approved by a second admin, and appended.
 */
@RestController
@RequestMapping("/api/v1/admin")
class AdminController {

    private final AdminService service;

    AdminController(AdminService service) {
        this.service = service;
    }

    private static Actor actor(Jwt jwt) {
        String name = jwt.getClaimAsString("preferred_username");
        return new Actor(jwt.getSubject(), name != null ? name : jwt.getSubject());
    }

    // ---- inspect
    @GetMapping("/users/{userId}/wallet")
    WalletInfo wallet(@AuthenticationPrincipal Jwt jwt, @PathVariable String userId) {
        return service.wallet(actor(jwt), jwt.getClaimAsString("iss"), userId);
    }

    @GetMapping("/users/{userId}/transfers")
    List<TransferInfo> transfers(@PathVariable String userId, @RequestParam(defaultValue = "50") int limit) {
        return service.transfers(userId, limit);
    }

    @GetMapping("/accounts/{accountId}/entries")
    EntriesPage entries(@PathVariable UUID accountId, @RequestParam(required = false) Long before, @RequestParam(defaultValue = "50") int limit) {
        return service.entries(accountId, before, limit);
    }

    /** Empty list = every cached balance matches its ledger entries. */
    @GetMapping("/reconciliation")
    List<Discrepancy> reconciliation() {
        return service.reconciliation();
    }

    @GetMapping("/actions")
    List<ActionView> actions(@RequestParam(defaultValue = "PENDING") AdminAction.Status status, @RequestParam(defaultValue = "50") int limit) {
        return service.actions(status, limit);
    }

    // ---- request corrections (nothing moves until a second admin approves)
    @PostMapping("/adjustments")
    ResponseEntity<ActionView> adjust(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody AdjustmentRequest request) {
        return ResponseEntity.status(201).body(service.requestAdjustment(actor(jwt), request));
    }

    @PostMapping("/transfers/{id}/reversal")
    ResponseEntity<ActionView> reverse(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @Valid @RequestBody ReversalRequest request) {
        return ResponseEntity.status(201).body(service.requestReversal(actor(jwt), id, request));
    }

    // ---- decide
    @PostMapping("/actions/{id}/approve")
    ActionView approve(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @Valid @RequestBody(required = false) DecisionRequest body) {
        return service.approve(actor(jwt), id, body == null ? null : body.note());
    }

    @PostMapping("/actions/{id}/reject")
    ActionView reject(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id, @Valid @RequestBody(required = false) DecisionRequest body) {
        return service.reject(actor(jwt), id, body == null ? null : body.note());
    }
}
