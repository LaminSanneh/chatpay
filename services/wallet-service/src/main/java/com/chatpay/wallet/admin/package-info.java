/**
 * Finance operations for humans (role wallet-admin): inspect money and request corrections.
 * It never edits history: an approved correction APPENDS new ledger entries through the ledger's public API.
 * Nothing depends on this module, so it exposes no public types.
 */
@ApplicationModule(displayName = "Admin")
package com.chatpay.wallet.admin;

import org.springframework.modulith.ApplicationModule;
