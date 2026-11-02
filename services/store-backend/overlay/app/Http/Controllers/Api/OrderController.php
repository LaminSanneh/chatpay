<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\DomainError;
use App\Http\Controllers\Controller;
use App\Http\Json\Json;
use App\Http\Requests\CreateOrderRequest;
use App\Models\Order;
use App\Services\OrderService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class OrderController extends Controller
{
    public function __construct(private OrderService $orders) {}

    /** Checkout. Prices come from our database. The response carries the payment intent the buyer confirms in the wallet. */
    public function store(CreateOrderRequest $request): JsonResponse
    {
        $order = $this->orders->create($request->attributes->get('user_id'), $request->validated());

        return response()->json(Json::order($order), 201);
    }

    public function index(Request $request): JsonResponse
    {
        $me = $request->attributes->get('user_id');
        $orders = Order::query()->with(['items', 'store'])
            ->where(fn ($q) => $q->where('buyer_user_id', $me)->orWhere('recipient_user_id', $me))
            ->latest()->limit(50)->get();

        return response()->json($orders->map(fn (Order $o) => Json::order($o))->values());
    }

    public function show(Request $request, Order $order): JsonResponse
    {
        $this->authorizeOwner($request, $order);

        return response()->json(Json::order($order));
    }

    /** Buyer gives up on an unpaid order. (If they pay anyway, it is refunded automatically.) */
    public function cancel(Request $request, Order $order): JsonResponse
    {
        if ($order->buyer_user_id !== $request->attributes->get('user_id')) {
            throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);
        }

        return response()->json(Json::order($this->orders->cancel($order)));
    }

    private function authorizeOwner(Request $request, Order $order): void
    {
        $me = $request->attributes->get('user_id');
        if ($order->buyer_user_id !== $me && $order->recipient_user_id !== $me) {
            throw new DomainError('ORDER_NOT_FOUND', 'Order not found', 404);   // same answer as "missing"
        }
    }
}
