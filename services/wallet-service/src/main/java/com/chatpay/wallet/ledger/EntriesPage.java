package com.chatpay.wallet.ledger;

import java.util.List;

/** `nextBefore` is the cursor for the next (older) page, or null when there are no more entries. */
public record EntriesPage(List<EntryView> items, Long nextBefore) {}
