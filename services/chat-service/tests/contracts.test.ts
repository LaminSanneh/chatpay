/**
 * The shared event fixtures (contracts/events) against the REAL zod schemas the chat service uses to read events.
 * If a producer changes an event and updates its fixture, this test says whether the chat service can still read it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ZodTypeAny } from 'zod';
import { OrderPaid, StoreClosed, StoreOpened, TransferCompleted } from '../src/messaging/consumers';

const DIR = path.resolve(__dirname, '../../../contracts/events');
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const index: { file: string; consumers: string[] }[] = load('index.json');

const COVERED: Record<string, ZodTypeAny> = {
  'transfer.completed.p2p.json': TransferCompleted,
  'transfer.completed.order-payment.json': TransferCompleted,
  'order.paid.json': OrderPaid,
  'store.opened.json': StoreOpened,
  'store.closed.json': StoreClosed,
};

describe('contracts: every event the chat service consumes is covered here', () => {
  test('the index and this test agree on which fixtures the chat service reads', () => {
    const listed = index.filter((e) => e.consumers.includes('chat-service')).map((e) => e.file).sort();
    assert.deepEqual(Object.keys(COVERED).sort(), listed);
  });
});

describe('contracts: the chat service can read every fixture it consumes', () => {
  for (const [file, schema] of Object.entries(COVERED)) {
    test(`${file} parses`, () => assert.doesNotThrow(() => schema.parse(load(file))));
    test(`${file} still parses when the producer adds a field`, () => assert.doesNotThrow(() => schema.parse({ ...load(file), someFutureField: { nested: true } })));
  }

  test('what the chat reads from a person-to-person payment', () => {
    const e = TransferCompleted.parse(load('transfer.completed.p2p.json'));
    assert.equal(e.kind, 'P2P');
    assert.equal(e.amountMinor, 2500);
    assert.equal(e.fromUserId, '11111111-1111-4111-8111-111111111111');
    assert.equal(e.referenceType, 'chat');
    assert.equal(e.referenceId, '7c1f0e9a-2b3d-4c5e-8f6a-9b0c1d2e3f40');
  });

  test('what the chat reads from a paid order', () => {
    const e = OrderPaid.parse(load('order.paid.json'));
    assert.equal(e.totalMinor, 5000);
    assert.equal(e.recipientUserId, '22222222-2222-4222-8222-222222222222');
    assert.deepEqual(e.items[0], { name: 'Ceramic mug', quantity: 2, unitPriceMinor: 2500, imageUrl: 'https://example.com/mug.png' });
    assert.deepEqual(e.context, { type: 'chat', roomId: '7c1f0e9a-2b3d-4c5e-8f6a-9b0c1d2e3f40' });
  });

  test('what the chat reads from the store events', () => {
    assert.deepEqual(StoreOpened.parse(load('store.opened.json')), { ownerUserId: '22222222-2222-4222-8222-222222222222', storeId: '7', name: "Bob's Shop", slug: 'bobs-shop' });
    assert.deepEqual(StoreClosed.parse(load('store.closed.json')), { ownerUserId: '22222222-2222-4222-8222-222222222222', storeId: '7' });
  });

  test('a payload missing a field the chat needs, or with a wrong type, is rejected (and so dead-lettered, not retried)', () => {
    const { fromUserId: _gone, ...withoutSender } = load('transfer.completed.p2p.json');
    assert.throws(() => TransferCompleted.parse(withoutSender));
    assert.throws(() => TransferCompleted.parse({ ...load('transfer.completed.p2p.json'), amountMinor: '2500' }));
    assert.throws(() => OrderPaid.parse({ ...load('order.paid.json'), items: 'none' }));
    assert.throws(() => StoreOpened.parse({ storeId: '7' }));
  });
});
