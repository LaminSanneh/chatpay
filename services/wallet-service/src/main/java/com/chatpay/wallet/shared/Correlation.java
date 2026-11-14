package com.chatpay.wallet.shared;

import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.MDC;

/**
 * The correlation id of the request being handled. One id follows a request through every service, its stored event, the AMQP message, the
 * consumers' log lines and any dead letter, so "what happened to this payment?" is a single search.
 * It lives in the SLF4J MDC (set by {@link CorrelationIdFilter}), which is what the log pattern prints.
 */
public final class Correlation {

    public static final String HEADER = "X-Correlation-Id";
    public static final String AMQP_HEADER = "x-correlation-id";
    public static final String MDC_KEY = "correlationId";

    /** Letters, digits and . _ : - only, at most 64 characters: anything else (spaces, newlines, huge values) could forge or flood a log line. */
    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._:-]{1,64}");

    private Correlation() {}

    /** The id of the request being handled, or null outside one. */
    public static String current() {
        return MDC.get(MDC_KEY);
    }

    /** The current id, or a fresh one when nothing is being handled (a test, a scheduled job). */
    public static String currentOrNew() {
        String id = current();
        return id != null ? id : generate();
    }

    public static String generate() {
        return UUID.randomUUID().toString();
    }

    /** The value if it is an acceptable id, otherwise null. */
    public static String sanitize(String raw) {
        return raw != null && VALID.matcher(raw).matches() ? raw : null;
    }
}
