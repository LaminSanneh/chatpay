package com.chatpay.wallet.shared;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.amqp.core.TopicExchange;
import org.springframework.amqp.support.converter.Jackson2JsonMessageConverter;
import org.springframework.amqp.support.converter.MessageConverter;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class MessagingConfig {

    /** Declared on startup by RabbitAdmin. The chat service asserts the same exchange (idempotent). */
    @Bean
    TopicExchange walletEventsExchange(@Value("${wallet.events-exchange}") String name) {
        return new TopicExchange(name, true, false);
    }

    /** Events leave the wallet as plain JSON, so any consumer (Node, Go, ...) can read them. */
    @Bean
    MessageConverter jsonMessageConverter(ObjectMapper objectMapper) {
        return new Jackson2JsonMessageConverter(objectMapper);
    }
}
