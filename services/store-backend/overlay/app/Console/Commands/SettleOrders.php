<?php

namespace App\Console\Commands;

use App\Support\Correlation;
use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

class SettleOrders extends Command
{
    protected $signature = 'orders:settle';
    protected $description = 'Release escrow to the store for delivered orders whose return window has passed';

    public function handle(OrderService $orders): int
    {
        $cutoff = now()->subDays(config('store.return_window_days'));
        $done = 0;
        Order::query()->where('status', Order::DELIVERED)->where('delivered_at', '<=', $cutoff)->each(function (Order $order) use ($orders, &$done) {
            $id = Correlation::generate();
            try {
                Correlation::within($id, fn () => $orders->settle($order));      // one id per payout: the wallet and its event carry it
                $done++;
            } catch (\Throwable $e) {
                Log::error('Payout failed, will retry on the next run', ['order' => $order->id, 'error' => $e->getMessage(), 'correlation_id' => $id]);
            }
        });
        $this->info("Paid out {$done} orders");

        return self::SUCCESS;
    }
}
