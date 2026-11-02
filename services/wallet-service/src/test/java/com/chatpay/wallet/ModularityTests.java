package com.chatpay.wallet;

import org.junit.jupiter.api.Test;
import org.springframework.modulith.core.ApplicationModules;

/**
 * This is what makes "clean package boundaries" REAL instead of a convention:
 * the build fails if a module reaches into another module's `internal` package,
 * or if modules form a dependency cycle.
 */
class ModularityTests {

    @Test
    void modulesRespectTheirBoundaries() {
        ApplicationModules.of(WalletApplication.class).verify();
    }
}
