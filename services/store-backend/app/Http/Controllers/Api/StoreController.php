<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\DomainError;
use App\Http\Controllers\Controller;
use App\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Selling on the platform. Anyone signed in can APPLY for a store; it starts as `pending` and is invisible to shoppers.
 * A platform admin activates it in /admin (which announces it to the chat), after which the owner can use /vendor.
 */
class StoreController extends Controller
{
    public function apply(Request $request): JsonResponse
    {
        $me = $request->attributes->get('user_id');
        $data = $request->validate([
            'name' => ['required', 'string', 'min:3', 'max:120'],
            'description' => ['nullable', 'string', 'max:500'],
        ]);

        if (Store::query()->where('owner_user_id', $me)->exists()) {
            throw new DomainError('STORE_EXISTS', 'You already have a store', 409);
        }

        $store = Store::create([
            'owner_user_id' => $me,
            'name' => $data['name'],
            'slug' => $this->uniqueSlug($data['name']),
            'description' => $data['description'] ?? null,
            'status' => 'pending',
        ]);

        return response()->json($this->json($store), 201);
    }

    /** The caller's own store (or null), whatever its status. */
    public function mine(Request $request): JsonResponse
    {
        $store = Store::query()->where('owner_user_id', $request->attributes->get('user_id'))->first();

        return response()->json(['store' => $store ? $this->json($store) : null]);
    }

    private function json(Store $s): array
    {
        return ['id' => $s->id, 'name' => $s->name, 'slug' => $s->slug, 'description' => $s->description, 'status' => $s->status];
    }

    private function uniqueSlug(string $name): string
    {
        $base = Str::slug($name) ?: 'store';
        $slug = $base;
        for ($i = 2; Store::query()->where('slug', $slug)->exists(); $i++) {
            $slug = "{$base}-{$i}";
        }

        return $slug;
    }
}
