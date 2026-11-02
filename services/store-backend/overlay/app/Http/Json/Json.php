<?php

namespace App\Http\Json;

use App\Models\Order;
use App\Models\Product;

/** The public JSON shapes. Money is always integer minor units (100 = D1.00). */
class Json
{
    public static function product(Product $p): array
    {
        return [
            'id' => $p->id,
            'slug' => $p->slug,
            'name' => $p->name,
            'description' => $p->description,
            'priceMinor' => $p->price_minor,
            'currency' => $p->currency,
            'stock' => $p->stock,
            'imageUrl' => $p->image_url,
            'isHot' => $p->is_hot,
            'category' => $p->category ? ['id' => $p->category->id, 'name' => $p->category->name, 'slug' => $p->category->slug] : null,
            'store' => $p->store ? ['id' => $p->store->id, 'name' => $p->store->name, 'slug' => $p->store->slug] : null,
        ];
    }

    public static function order(Order $o): array
    {
        $o->loadMissing('items', 'store');

        return [
            'id' => $o->id,
            'status' => $o->status,
            'totalMinor' => $o->total_minor,
            'currency' => $o->currency,
            'store' => ['id' => $o->store->id, 'name' => $o->store->name, 'slug' => $o->store->slug],
            'items' => $o->items->map(fn ($i) => [
                'productId' => $i->product_id, 'name' => $i->name, 'quantity' => $i->quantity,
                'unitPriceMinor' => $i->unit_price_minor, 'imageUrl' => $i->image_url,
            ])->values()->all(),
            'buyerUserId' => $o->buyer_user_id,
            'giftFor' => $o->recipient_user_id,
            'chatContext' => $o->chat_context,
            // Confirm this in the wallet with the buyer's own token (POST /api/v1/transfer-intents/{intentId}/confirm).
            'payment' => ['intentId' => $o->payment_intent_id, 'expiresAt' => $o->expires_at?->toIso8601String()],
            'createdAt' => $o->created_at->toIso8601String(),
            'paidAt' => $o->paid_at?->toIso8601String(),
        ];
    }
}
