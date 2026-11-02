package com.chatpay.wallet.transfer;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** PUBLIC read API of the transfer module. Money moves only through confirmed intents, never through this interface. */
public interface TransferApi {
    Optional<TransferInfo> find(UUID id);
    List<TransferInfo> recentForUser(String userId, int limit);
}
