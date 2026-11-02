package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.transfer.internal.TransferDtos.TransferView;
import java.util.List;
import java.util.UUID;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Completed transfers (history/receipts). There is deliberately no "POST /transfers": see TransferIntentController. */
@RestController
@RequestMapping("/api/v1/transfers")
class TransferController {

    private final TransferService service;

    TransferController(TransferService service) {
        this.service = service;
    }

    @GetMapping
    List<TransferView> mine(@AuthenticationPrincipal Jwt jwt, @RequestParam(defaultValue = "30") int limit) {
        return service.listForUser(jwt.getSubject(), limit);
    }

    @GetMapping("/{id}")
    TransferView one(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return service.getForUser(jwt.getSubject(), id);
    }
}
