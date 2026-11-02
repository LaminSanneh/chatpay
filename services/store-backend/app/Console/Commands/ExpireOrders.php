<?php

namespace App\Console\Commands;

use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Console\Command;

class ExpireOrders extends Command
{
    protected $signature = 'orders:expire';
    protected $description = 'Cancel unpaid orders that passed their deadline and give the stock back';

    public function handle(OrderService $orders): int
    {
        $count = 0;
        Order::query()->where('status', Order::PENDING)->where('expires_at', '<', now())->each(function (Order $order) use ($orders, &$count) {
            $orders->cancel($order);
            $count++;
        });
        $this->info("Expired {$count} unpaid orders");

        return self::SUCCESS;
    }
}
