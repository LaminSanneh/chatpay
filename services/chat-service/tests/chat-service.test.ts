import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { adapters, closePool, setup } from './helpers';

after(closePool);

for (const adapter of adapters) {
  describe(`ChatService [${adapter.name}]`, () => {
    const fresh = () => setup(adapter.make);

    test('one direct room per pair, regardless of who starts it', async () => {
      const { chat } = await fresh();
      const a = await chat.getOrCreateDirect('alice', 'bob');
      const b = await chat.getOrCreateDirect('bob', 'alice');
      assert.equal(a.id, b.id);
      assert.equal(a.visibility, 'private');
    });

    test('only members can read or write a room', async () => {
      const { chat } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      await assert.rejects(chat.sendText('carol', room.id, 'hi'), { code: 'ROOM_NOT_FOUND' });
      await assert.rejects(chat.history('carol', room.id), { code: 'ROOM_NOT_FOUND' });
      assert.equal((await chat.sendText('alice', room.id, ' hello ')).text, 'hello');
    });

    test('history pages backwards with the seq cursor', async () => {
      const { chat } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      for (let i = 1; i <= 5; i++) await chat.sendText('alice', room.id, `m${i}`);
      const page1 = await chat.history('bob', room.id, { limit: 2 });
      assert.deepEqual(page1.map((m) => m.text), ['m4', 'm5']);
      const page2 = await chat.history('bob', room.id, { limit: 2, before: page1[0].seq });
      assert.deepEqual(page2.map((m) => m.text), ['m2', 'm3']);
    });

    test('private groups are hidden and invite-only; public groups can be joined', async () => {
      const { chat } = await fresh();
      const priv = await chat.createGroup('alice', { name: 'Secret', visibility: 'private' });
      const pub = await chat.createGroup('alice', { name: 'Lobby', visibility: 'public' });
      assert.deepEqual((await chat.listPublicGroups()).map((r) => r.name), ['Lobby']);
      await assert.rejects(chat.joinGroup('bob', priv.id), { code: 'ROOM_NOT_FOUND' });
      const joined = await chat.joinGroup('bob', pub.id);
      assert.ok(joined.memberIds.includes('bob'));
    });

    test('inviting many users: pending invites, accept joins, decline does not', async () => {
      const { chat, events } = await fresh();
      const room = await chat.createGroup('alice', { name: 'Team', visibility: 'private', inviteeIds: ['bob', 'carol', 'nobody', 'alice'] });
      assert.equal(events.filter((e) => e.type === 'invite:new').length, 2);   // unknown user and self are skipped
      const bobInvites = await chat.listInvites('bob');
      assert.equal(bobInvites.length, 1);
      assert.equal(bobInvites[0].room.name, 'Team');

      const joined = await chat.respondToInvite('bob', bobInvites[0].id, true);
      assert.ok(joined?.memberIds.includes('bob'));
      assert.equal((await chat.listInvites('bob')).length, 0);

      const carolInvite = (await chat.listInvites('carol'))[0];
      assert.equal(await chat.respondToInvite('carol', carolInvite.id, false), null);
      await assert.rejects(chat.respondToInvite('carol', carolInvite.id, true), { code: 'INVITE_CLOSED' });
      await assert.rejects(chat.respondToInvite('dave', carolInvite.id, true), { code: 'INVITE_NOT_FOUND' });

      assert.equal((await chat.listRooms('carol')).some((r) => r.id === room.id), false);
    });

    test('re-inviting the same person does not create a second pending invite', async () => {
      const { chat } = await fresh();
      const room = await chat.createGroup('alice', { name: 'Team', visibility: 'private' });
      await chat.inviteToGroup('alice', room.id, ['bob']);
      await chat.inviteToGroup('alice', room.id, ['bob']);
      assert.equal((await chat.listInvites('bob')).length, 1);
    });

    test('plain members cannot invite to a private group, but can to a public one', async () => {
      const { chat } = await fresh();
      const priv = await chat.createGroup('alice', { name: 'Secret', visibility: 'private', inviteeIds: ['bob'] });
      await chat.respondToInvite('bob', (await chat.listInvites('bob'))[0].id, true);
      await assert.rejects(chat.inviteToGroup('bob', priv.id, ['carol']), { code: 'NOT_ALLOWED' });

      const pub = await chat.createGroup('alice', { name: 'Lobby', visibility: 'public' });
      await chat.joinGroup('bob', pub.id);
      assert.deepEqual(await chat.inviteToGroup('bob', pub.id, ['carol']), { invited: 1 });
    });

    test('unread and mention counts, read cursor, and own messages are never unread', async () => {
      const { chat } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      await chat.sendText('alice', room.id, 'first');
      await chat.sendText('alice', room.id, 'hey @bob', ['bob']);

      const bobView = (await chat.listRooms('bob'))[0];
      assert.equal(bobView.unreadCount, 2);
      assert.equal(bobView.mentionCount, 1);
      assert.equal(bobView.lastMessage?.text, 'hey @bob');
      assert.equal((await chat.listRooms('alice'))[0].unreadCount, 0);   // your own messages are never unread

      await chat.sendText('bob', room.id, 'reply');                      // replying means you have read everything before it
      assert.equal((await chat.listRooms('bob'))[0].unreadCount, 0);
      assert.equal((await chat.listRooms('alice'))[0].unreadCount, 1);   // only bob's reply

      await chat.markRead('alice', room.id);
      assert.equal((await chat.listRooms('alice'))[0].unreadCount, 0);
      await chat.sendText('bob', room.id, 'one more');
      await chat.markRead('alice', room.id, 1);                          // cursors never move backwards
      assert.equal((await chat.listRooms('alice'))[0].unreadCount, 1);
    });

    test('mentions: only other members count, and a mention event is emitted', async () => {
      const { chat, events } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      const m = await chat.sendText('alice', room.id, 'hi @bob @carol @alice', ['bob', 'carol', 'alice', 'bob']);
      assert.deepEqual(m.mentions, ['bob']);
      const ev = events.find((e) => e.type === 'mention');
      assert.ok(ev && ev.type === 'mention' && ev.userIds.length === 1 && ev.userIds[0] === 'bob');
    });

    test('typing is announced to the other members', async () => {
      const { chat, events } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      await chat.typing('alice', room.id);
      const ev = events.find((e) => e.type === 'typing');
      assert.ok(ev && ev.type === 'typing' && ev.userId === 'alice' && ev.memberIds.includes('bob'));
    });

    test('leaving a group hands ownership to someone else', async () => {
      const { chat } = await fresh();
      const room = await chat.createGroup('alice', { name: 'Lobby', visibility: 'public' });
      await chat.joinGroup('bob', room.id);
      await chat.leaveGroup('alice', room.id);
      const view = (await chat.listRooms('bob'))[0];
      assert.equal(view.roles['bob'], 'owner');
      assert.equal(view.memberIds.includes('alice'), false);
      await assert.rejects(chat.leaveGroup('alice', room.id), { code: 'ROOM_NOT_FOUND' });
    });

    test('store events show up on user profiles, even before the owner has chatted', async () => {
      const { chat } = await fresh();
      await chat.applyStoreOpened({ ownerUserId: 'bob', storeId: 's1', name: "Bob's Shop", slug: 'bobs-shop' });
      await chat.applyStoreOpened({ ownerUserId: 'ghost', storeId: 's2', name: 'Ghost Shop', slug: 'ghost' });
      assert.equal((await chat.searchUsers('bob', 'alice'))[0].store?.slug, 'bobs-shop');
      await chat.touchUser({ userId: 'ghost', username: 'ghost', displayName: 'Ghost' });
      assert.equal((await chat.searchUsers('ghost', 'alice'))[0].store?.name, 'Ghost Shop');
      await chat.applyStoreClosed({ ownerUserId: 'bob', storeId: 's1' });
      assert.equal((await chat.searchUsers('bob', 'alice'))[0].store, null);
    });

    test('transfer event becomes ONE payment message, even if delivered twice', async () => {
      const { chat, events } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      const evt = {
        transferId: '11111111-1111-1111-1111-111111111111', intentId: 'i-1', kind: 'P2P', fromUserId: 'alice', toUserId: 'bob',
        amountMinor: 2000, currency: 'GMD', note: 'lunch', referenceType: 'chat', referenceId: room.id,
      };
      const first = await chat.applyTransferCompleted(evt);
      assert.equal(await chat.applyTransferCompleted(evt), null);
      assert.equal(first?.kind, 'payment');
      assert.equal(first?.payment?.intentId, 'i-1');
      assert.equal((await chat.history('bob', room.id)).filter((m) => m.kind === 'payment').length, 1);
      assert.ok(events.some((e) => e.type === 'message:new' && e.message.payment?.amountMinor === 2000));
      assert.equal((await chat.listRooms('bob'))[0].unreadCount, 1);   // recipient sees an unread bubble
      assert.equal((await chat.listRooms('alice'))[0].unreadCount, 0); // payer does not
    });

    test('transfer events that do not match the room (or are not P2P) are ignored', async () => {
      const { chat } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      const base = { transferId: '22222222-2222-2222-2222-222222222222', amountMinor: 100, currency: 'GMD', referenceType: 'chat', referenceId: room.id };
      assert.equal(await chat.applyTransferCompleted({ ...base, fromUserId: 'alice', toUserId: 'carol' }), null);
      assert.equal(await chat.applyTransferCompleted({ ...base, fromUserId: 'alice', toUserId: 'bob', referenceType: 'order' }), null);
      assert.equal(await chat.applyTransferCompleted({ ...base, fromUserId: 'alice', toUserId: 'bob', kind: 'ORDER_PAYMENT' }), null);
      assert.equal((await chat.history('alice', room.id)).length, 0);
    });

    test('order.paid becomes ONE gift bubble in the chat it came from; self-purchases and mismatches are ignored', async () => {
      const { chat, events } = await fresh();
      const room = await chat.getOrCreateDirect('alice', 'bob');
      const evt = {
        orderId: 'ord-1', storeId: 's1', storeName: "Bob's Shop", buyerUserId: 'alice', recipientUserId: 'bob', totalMinor: 5000,
        currency: 'GMD', items: [{ name: 'Mug', quantity: 2, unitPriceMinor: 2500, imageUrl: null }], context: { type: 'chat', roomId: room.id },
      };
      const first = await chat.applyOrderPaid(evt);
      assert.equal(first?.kind, 'order');
      assert.equal(first?.order?.items[0].name, 'Mug');
      assert.equal(await chat.applyOrderPaid(evt), null);                                           // duplicate delivery
      assert.equal((await chat.history('bob', room.id)).filter((m) => m.kind === 'order').length, 1);
      assert.ok(events.some((e) => e.type === 'message:new' && e.message.order?.orderId === 'ord-1'));
      assert.equal((await chat.listRooms('bob'))[0].unreadCount, 1);

      assert.equal(await chat.applyOrderPaid({ ...evt, orderId: 'ord-2', recipientUserId: null }), null);                       // self-purchase
      assert.equal(await chat.applyOrderPaid({ ...evt, orderId: 'ord-3', recipientUserId: 'carol' }), null);                    // carol is not in the room
      assert.equal(await chat.applyOrderPaid({ ...evt, orderId: 'ord-4', context: { type: 'web', roomId: room.id } }), null);   // not from chat
    });
  });
}
