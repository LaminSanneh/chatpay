<?php

namespace App\Messaging;

use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Message\AMQPMessage;
use PhpAmqpLib\Wire\AMQPTable;

/** ChannelPort over a php-amqplib channel. Publisher confirms are on: publish() returns only once the broker has stored the message. */
final class AmqpLibChannel implements ChannelPort
{
    public function __construct(private readonly AMQPChannel $channel)
    {
        $this->channel->confirm_select();
    }

    public static function delivery(AMQPMessage $message): Delivery
    {
        $headers = $message->has('application_headers') ? $message->get('application_headers')->getNativeData() : [];

        return new Delivery(
            $message->getBody(), (string) $message->getRoutingKey(), $headers, $message->getDeliveryTag(),
            $message->has('message_id') ? $message->get('message_id') : null,
            $message->has('content_type') ? $message->get('content_type') : null,
        );
    }

    public function declareExchange(string $name, string $type): void
    {
        $this->channel->exchange_declare($name, $type, false, true, false);
    }

    public function declareQueue(string $name, array $arguments = []): void
    {
        $this->channel->queue_declare($name, false, true, false, false, false, $arguments ? new AMQPTable($arguments) : []);
    }

    public function bind(string $queue, string $exchange, string $routingKey = ''): void
    {
        $this->channel->queue_bind($queue, $exchange, $routingKey);
    }

    public function publish(string $exchange, string $routingKey, string $body, array $headers, ?string $contentType, ?string $messageId): void
    {
        $properties = ['delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT, 'application_headers' => new AMQPTable($headers)];
        if ($contentType !== null) {
            $properties['content_type'] = $contentType;
        }
        if ($messageId !== null) {
            $properties['message_id'] = $messageId;
        }
        $this->channel->basic_publish(new AMQPMessage($body, $properties), $exchange, $routingKey);
        $this->channel->wait_for_pending_acks();
    }

    public function ack(mixed $tag): void
    {
        $this->channel->basic_ack($tag);
    }

    public function requeue(mixed $tag): void
    {
        $this->channel->basic_nack($tag, false, true);
    }
}
