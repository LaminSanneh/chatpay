package com.chatpay.wallet.transfer.internal;

import com.chatpay.wallet.transfer.internal.TransferDtos.TopUpRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.context.annotation.Profile;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Only exists under the "dev" profile. Real money in/out is a separate (PSP / mobile-money) module later. */
@Profile("dev")
@RestController
@RequestMapping("/api/v1/dev")
class DevTopUpController {

    private final TransferService service;

    DevTopUpController(TransferService service) {
        this.service = service;
    }

    @PostMapping("/topup")
    Map<String, Long> topUp(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody TopUpRequest req) {
        long balance = service.devTopUp(jwt.getClaimAsString("iss"), jwt.getSubject(), req.amountMinor());
        return Map.of("balanceMinor", balance);
    }
}
