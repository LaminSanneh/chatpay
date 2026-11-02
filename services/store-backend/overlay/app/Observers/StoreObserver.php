<?php

namespace App\Observers;

use App\Models\Store;
use App\Services\EventPublisher;

/** Tells the chat app when a store opens or closes, so contacts with a store get the store icon. */
class StoreObserver
{
    public function __construct(private EventPublisher $events) {}

    public function saved(Store $store): void
    {
        $wasActive = ($store->getOriginal('status') === 'active');
        $isActive = $store->isActive();

        if ($isActive && (! $wasActive || $store->wasChanged(['name', 'slug']))) {
            $this->events->publish(config('store.amqp.store_exchange'), 'store.opened', [
                'ownerUserId' => $store->owner_user_id,
                'storeId' => (string) $store->id,
                'name' => $store->name,
                'slug' => $store->slug,
            ]);
        } elseif (! $isActive && $wasActive) {
            $this->events->publish(config('store.amqp.store_exchange'), 'store.closed', [
                'ownerUserId' => $store->owner_user_id,
                'storeId' => (string) $store->id,
            ]);
        }
    }
}
