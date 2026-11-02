/**
 * Cross-cutting code every module may use (errors, security, messaging config).
 * Declared OPEN so Spring Modulith allows access to its internals. Keep it tiny
 * and free of business logic, otherwise it becomes a dumping ground.
 */
@ApplicationModule(type = ApplicationModule.Type.OPEN)
package com.chatpay.wallet.shared;

import org.springframework.modulith.ApplicationModule;
