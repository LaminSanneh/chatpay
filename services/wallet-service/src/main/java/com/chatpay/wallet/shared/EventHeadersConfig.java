package com.chatpay.wallet.shared;

import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.modulith.events.EventExternalizationConfiguration;

/**
 * Same externalization as Spring Modulith's default (events annotated with @Externalized, routed by the annotation) plus ONE addition: the
 * event's correlation id is sent as the AMQP header x-correlation-id. The id is read from the stored event itself, so it is also sent when the
 * event is republished later (after a broker outage), long after the request is over.
 */
@Configuration
class EventHeadersConfig {

    @Bean
    EventExternalizationConfiguration eventExternalizationConfiguration() {
        return EventExternalizationConfiguration.defaults("com.chatpay.wallet")
                .headers(EventHeadersConfig::headersOf)
                .build();
    }

    static Map<String, Object> headersOf(Object event) {
        if (event instanceof CorrelatedEvent correlated && correlated.correlationId() != null) {
            return Map.of(Correlation.AMQP_HEADER, correlated.correlationId());
        }
        return Map.of();
    }
}
