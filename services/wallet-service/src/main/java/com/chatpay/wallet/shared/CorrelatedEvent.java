package com.chatpay.wallet.shared;

/** An event that carries the correlation id of the request that caused it (also sent as the AMQP header x-correlation-id). */
public interface CorrelatedEvent {

    String correlationId();
}
