package com.chatpay.wallet.ledger;

import java.util.List;
import java.util.UUID;

/** One balanced business event: debits must equal credits. `id` is shared by every entry it creates. */
public record LedgerTransaction(UUID id, String currency, String kind, String description,
                                String referenceType, String referenceId, List<Posting> postings) {}
