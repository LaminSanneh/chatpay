<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

class CreateOrderRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;   // authentication is done by the `kc` middleware
    }

    public function rules(): array
    {
        return [
            'items' => ['required', 'array', 'min:1', 'max:50'],
            'items.*.productId' => ['required', 'integer'],
            'items.*.quantity' => ['required', 'integer', 'min:1', 'max:99'],
            // buy for someone else: their Keycloak user id (the chat app knows it)
            'giftFor' => ['nullable', 'uuid'],
            // where the purchase was made, so the chat can show the order bubble
            'context' => ['nullable', 'array'],
            'context.type' => ['required_with:context', 'in:chat'],
            'context.roomId' => ['required_with:context', 'string', 'max:128'],
            'shipping' => ['nullable', 'array'],
            'shipping.name' => ['nullable', 'string', 'max:120'],
            'shipping.phone' => ['nullable', 'string', 'max:40'],
            'shipping.address' => ['nullable', 'string', 'max:300'],
            'shipping.city' => ['nullable', 'string', 'max:100'],
        ];
    }
}
