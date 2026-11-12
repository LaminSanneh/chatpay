/**
 * Permanent in-memory stand-in for an amqplib connection, for testing reconnect logic without a broker. Tests make it lose the connection or
 * the channel with `emit('close')`, or fail with `emit('error', ...)`, exactly as amqplib reports them.
 * Used by: services/chat-service/tests/resilience.test.ts
 */
import { EventEmitter } from 'node:events';
import { FakeChannel } from './fake-channel';

export class FakeConnection extends EventEmitter {
  closed = false;
  constructor(public channel: FakeChannel = new FakeChannel()) { super(); }
  async createConfirmChannel() { return this.channel; }
  async close() {
    if (this.closed) throw new Error('Connection closed');     // amqplib throws IllegalOperationError when closing twice
    this.closed = true;
  }
}
