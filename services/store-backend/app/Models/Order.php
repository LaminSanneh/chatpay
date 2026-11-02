<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * pending_payment -> paid -> shipped -> delivered -> completed (released to the store)
 *                 \-> cancelled                    \-> refunded (money returned to the buyer)
 * payment_review: a payment arrived that could not be matched or refunded automatically; needs a human.
 */
class Order extends Model
{
    use HasUuids;

    public const PENDING = 'pending_payment';
    public const PAID = 'paid';
    public const SHIPPED = 'shipped';
    public const DELIVERED = 'delivered';
    public const COMPLETED = 'completed';
    public const CANCELLED = 'cancelled';
    public const REFUNDED = 'refunded';
    public const REVIEW = 'payment_review';

    protected $fillable = [
        'buyer_user_id', 'recipient_user_id', 'store_id', 'status', 'total_minor', 'currency', 'payment_intent_id', 'transfer_id',
        'chat_context', 'shipping', 'expires_at', 'paid_at', 'shipped_at', 'delivered_at', 'settled_at', 'cancelled_at',
    ];

    protected function casts(): array
    {
        return [
            'total_minor' => 'integer', 'chat_context' => 'array', 'shipping' => 'array',
            'expires_at' => 'datetime', 'paid_at' => 'datetime', 'shipped_at' => 'datetime',
            'delivered_at' => 'datetime', 'settled_at' => 'datetime', 'cancelled_at' => 'datetime',
        ];
    }

    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
