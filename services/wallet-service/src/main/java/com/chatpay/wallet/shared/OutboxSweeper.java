package com.chatpay.wallet.shared;

import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.modulith.events.IncompleteEventPublications;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Republishes events that were stored with a money movement but could not be sent (RabbitMQ was down, or the publish failed).
 *
 * Modulith writes every event to the event_publication table in the SAME transaction as the money movement and marks it complete once it has
 * been published. Without this timer an unsent event stayed there until the wallet RESTARTED. Now it is retried every
 * wallet.event-republish-interval-ms, once it has been waiting longer than wallet.event-republish-min-age-seconds (so an event that is still
 * being published is not sent twice). Delivery stays at-least-once: every consumer is idempotent.
 */
@Component
class OutboxSweeper {

    private static final Logger log = LoggerFactory.getLogger(OutboxSweeper.class);

    private final IncompleteEventPublications incompleteEventPublications;
    private final Duration minAge;

    OutboxSweeper(IncompleteEventPublications incompleteEventPublications,
                  @Value("${wallet.event-republish-min-age-seconds:30}") long minAgeSeconds) {
        this.incompleteEventPublications = incompleteEventPublications;
        this.minAge = Duration.ofSeconds(minAgeSeconds);
    }

    @Scheduled(fixedDelayString = "${wallet.event-republish-interval-ms:30000}", initialDelayString = "${wallet.event-republish-interval-ms:30000}")
    void sweep() {
        try {
            incompleteEventPublications.resubmitIncompleteEventPublicationsOlderThan(minAge);
        } catch (RuntimeException e) {
            // Never let the timer die: the broker may simply still be down. The next tick tries again.
            log.warn("Could not republish stored events, will try again: {}", e.getMessage());
        }
    }
}
