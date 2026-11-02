<?php

namespace App\Services;

use App\Exceptions\DomainError;
use App\Models\Order;
use App\Models\Product;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

/**
 * Orders and their link to the wallet.
 *
 * Money flow: the buyer's payment is created by US (price from our database), confirmed by the buyer in the wallet,
 * held in escrow, then RELEASED to the store after delivery (minus commission) or REFUNDED to the buyer.
 * Every wallet call is idempotent (keys derived from the order id), so retries are always safe.
 */
class OrderService
{
    public function __construct(private WalletClient $wallet, private EventPublisher $events) {}

    // ------------------------------------------------------------------ checkout
    /** @param array{items: array, giftFor?: ?string, context?: ?array, shipping?: ?array} $data */
    public function create(string $buyerId, array $data): Order
    {
        $giftFor = $data['giftFor'] ?? null;
        if ($giftFor !== null && $giftFor === $buyerId) {
            throw new DomainError('INVALID_GIFT', 'You cannot gift an order to yourself');
        }

        $order = DB::transaction(function () use ($buyerId, $data, $giftFor) {
            $wanted = collect($data['items'])->groupBy('productId')->map(fn ($rows) => (int) $rows->sum('quantity'));
            $products = Product::query()->whereIn('id', $wanted->keys())->lockForUpdate()->get()->keyBy('id');

            if ($products->count() !== $wanted->count()) {
                throw new DomainError('PRODUCT_NOT_FOUND', 'One or more products do not exist');
            }
            if ($products->pluck('store_id')->unique()->count() !== 1) {
                throw new DomainError('MIXED_STORES', 'An order can only contain products from one store');
            }
            $store = $products->first()->store;
            if (! $store->isActive()) {
                throw new DomainError('STORE_UNAVAILABLE', 'This store is not open');
            }

            $total = 0;
            foreach ($wanted as $productId => $qty) {
                $p = $products[$productId];
                if ($p->status !== 'active') {
                    throw new DomainError('PRODUCT_UNAVAILABLE', "{$p->name} is not available");
                }
                if ($p->stock < $qty) {
                    throw new DomainError('OUT_OF_STOCK', "Only {$p->stock} of {$p->name} left", 409);
                }
                $total += $p->price_minor * $qty;
            }

            $order = Order::create([
                'buyer_user_id' => $buyerId,
                'recipient_user_id' => $giftFor,
                'store_id' => $store->id,
                'status' => Order::PENDING,
                'total_minor' => $total,
                'currency' => config('store.currency'),
                'chat_context' => $data['context'] ?? null,
                'shipping' => $data['shipping'] ?? null,
                'expires_at' => now()->addMinutes(config('store.unpaid_order_ttl_minutes')),
            ]);

            foreach ($wanted as $productId => $qty) {
                $p = $products[$productId];
                $p->decrement('stock', $qty);                                  // reserve the stock
                $order->items()->create([                                      // snapshot: what was bought, at what price
                    'product_id' => $p->id, 'name' => $p->name, 'unit_price_minor' => $p->price_minor,
                    'quantity' => $qty, 'image_url' => $p->image_url,
                ]);
            }

            return $order;
        });

        try {
            $intent = $this->wallet->createOrderIntent($buyerId, (string) $order->store_id, $order->id, $order->total_minor, 'Order '.substr($order->id, 0, 8));
        } catch (\Throwable $e) {
            Log::error('Could not create the payment for an order', ['order' => $order->id, 'error' => $e->getMessage()]);
            $this->cancel($order);                                             // give the stock back
            throw new DomainError('PAYMENT_UNAVAILABLE', 'Payments are unavailable right now, please try again shortly', 502);
        }

        $order->update(['payment_intent_id' => $intent['id'], 'expires_at' => Carbon::parse($intent['expiresAt'])]);

        return $order->load('items', 'store');
    }

    /** Unpaid order: cancel it and put the stock back. (A late payment is refunded automatically, see onTransferCompleted.) */
    public function cancel(Order $order): Order
    {
        return DB::transaction(function () use ($order) {
            $o = Order::query()->lockForUpdate()->findOrFail($order->id);
            if ($o->status !== Order::PENDING) {
                return $o;
            }
            $this->restock($o);
            $o->update(['status' => Order::CANCELLED, 'cancelled_at' => now()]);

            return $o;
        });
    }

    // ------------------------------------------------------------------ fulfilment
    public function ship(Order $order): Order
    {
        return $this->transition($order, [Order::PAID], Order::SHIPPED, 'shipped_at');
    }

    public function deliver(Order $order): Order
    {
        return $this->transition($order, [Order::SHIPPED], Order::DELIVERED, 'delivered_at');
    }

    /** Pay the store what it earned (minus the platform commission). Safe to call repeatedly. */
    public function settle(Order $order): Order
    {
        $o = $order->fresh(['store']);
        if ($o->status === Order::COMPLETED) {
            return $o;
        }
        if ($o->status !== Order::DELIVERED) {
            throw new DomainError('INVALID_TRANSITION', 'Only delivered orders can be paid out', 409);
        }
        $commission = intdiv($o->total_minor * $o->store->commissionBps(), 10000);
        $this->wallet->release($o->id, $commission, 'order-'.$o->id.'-release');
        $o->update(['status' => Order::COMPLETED, 'settled_at' => now()]);

        return $o;
    }

    /** Give the buyer their money back while it is still held in escrow (before payout). */
    public function refund(Order $order): Order
    {
        $o = $order->fresh();
        if ($o->status === Order::REFUNDED) {
            return $o;
        }
        if (! in_array($o->status, [Order::PAID, Order::SHIPPED, Order::REVIEW], true)) {
            throw new DomainError('INVALID_TRANSITION', 'This order cannot be refunded in its current state', 409);
        }
        $this->wallet->refund($o->id, 'order-'.$o->id.'-refund');
        if ($o->status === Order::PAID) {
            $this->restock($o);
        }
        $o->update(['status' => Order::REFUNDED]);

        return $o;
    }

    // ------------------------------------------------------------------ events from the wallet
    /** `transfer.completed` -> the order is paid. Only ORDER_PAYMENT events count; person-to-person payments are ignored. */
    public function onTransferCompleted(array $e): void
    {
        if (($e['kind'] ?? null) !== 'ORDER_PAYMENT' || ($e['referenceType'] ?? null) !== 'order') {
            return;
        }

        DB::transaction(function () use ($e) {
            $order = Order::query()->lockForUpdate()->find($e['referenceId'] ?? '');
            if (! $order) {
                Log::warning('Payment for an unknown order', ['event' => $e]);

                return;
            }

            if ($order->status !== Order::PENDING) {
                // Paid after we cancelled or expired it: the money is sitting in escrow, so give it back (once).
                if ($order->status === Order::CANCELLED && $order->transfer_id === null) {
                    $order->update(['transfer_id' => $e['transferId']]);
                    try {
                        $this->wallet->refund($order->id, 'order-'.$order->id.'-late-refund');
                        $order->update(['status' => Order::REFUNDED]);
                    } catch (\Throwable $ex) {
                        Log::error('Automatic refund of a late payment failed', ['order' => $order->id, 'error' => $ex->getMessage()]);
                        $order->update(['status' => Order::REVIEW]);
                    }
                }

                return;
            }

            $matches = ($e['intentId'] ?? null) === $order->payment_intent_id
                && ($e['fromUserId'] ?? null) === $order->buyer_user_id
                && (int) ($e['amountMinor'] ?? -1) === $order->total_minor
                && ($e['currency'] ?? null) === $order->currency;
            if (! $matches) {
                Log::error('Order payment does not match the order', ['order' => $order->id, 'event' => $e]);
                $order->update(['status' => Order::REVIEW, 'transfer_id' => $e['transferId'] ?? null]);

                return;
            }

            $order->update(['status' => Order::PAID, 'paid_at' => now(), 'transfer_id' => $e['transferId']]);
            $this->events->publish(config('store.amqp.store_exchange'), 'order.paid', $this->paidPayload($order));
        });
    }

    /** `settlement.completed` -> keep the order's final state in sync (e.g. a refund done by finance). */
    public function onSettlementCompleted(array $e): void
    {
        $order = Order::query()->find($e['orderId'] ?? '');
        if (! $order) {
            return;
        }
        if (($e['kind'] ?? null) === 'RELEASE' && $order->status === Order::DELIVERED) {
            $order->update(['status' => Order::COMPLETED, 'settled_at' => now()]);
        } elseif (($e['kind'] ?? null) === 'REFUND' && ! in_array($order->status, [Order::REFUNDED, Order::COMPLETED], true)) {
            $order->update(['status' => Order::REFUNDED]);
        }
    }

    // ------------------------------------------------------------------ helpers
    private function paidPayload(Order $order): array
    {
        $order->loadMissing('items', 'store');

        return [
            'orderId' => $order->id,
            'storeId' => (string) $order->store_id,
            'storeName' => $order->store->name,
            'buyerUserId' => $order->buyer_user_id,
            'recipientUserId' => $order->recipient_user_id,
            'totalMinor' => $order->total_minor,
            'currency' => $order->currency,
            'items' => $order->items->map(fn ($i) => [
                'name' => $i->name, 'quantity' => $i->quantity, 'unitPriceMinor' => $i->unit_price_minor, 'imageUrl' => $i->image_url,
            ])->values()->all(),
            'context' => $order->chat_context,
        ];
    }

    private function restock(Order $order): void
    {
        foreach ($order->items as $item) {
            if ($item->product_id) {
                Product::query()->whereKey($item->product_id)->increment('stock', $item->quantity);
            }
        }
    }

    private function transition(Order $order, array $from, string $to, string $stamp): Order
    {
        return DB::transaction(function () use ($order, $from, $to, $stamp) {
            $o = Order::query()->lockForUpdate()->findOrFail($order->id);
            if (! in_array($o->status, $from, true)) {
                throw new DomainError('INVALID_TRANSITION', "An order that is {$o->status} cannot become {$to}", 409);
            }
            $o->update(['status' => $to, $stamp => now()]);

            return $o;
        });
    }
}
