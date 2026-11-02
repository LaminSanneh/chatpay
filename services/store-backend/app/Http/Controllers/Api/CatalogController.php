<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Json\Json;
use App\Models\Category;
use App\Models\Product;
use App\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Public catalog. Shoppers only ever see active products of active stores. */
class CatalogController extends Controller
{
    public function categories(): JsonResponse
    {
        return response()->json(Category::query()->orderBy('name')->get(['id', 'name', 'slug']));
    }

    public function products(Request $request): JsonResponse
    {
        $query = Product::query()->visible()->with(['store', 'category']);

        if (($search = trim((string) $request->query('search', ''))) !== '') {
            $like = '%'.str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], mb_strtolower($search)).'%';
            $query->where(fn ($w) => $w->whereRaw('lower(name) like ?', [$like])->orWhereRaw('lower(coalesce(description, \'\')) like ?', [$like]));
        }
        if ($category = $request->query('category')) {
            $query->whereHas('category', fn ($c) => $c->where('slug', $category));
        }
        if ($store = $request->query('store')) {
            $query->whereHas('store', fn ($s) => $s->where('slug', $store));
        }

        $page = $query->orderByDesc('id')->paginate(min(max((int) $request->query('per_page', 24), 1), 60));

        return response()->json([
            'items' => $page->getCollection()->map(fn (Product $p) => Json::product($p))->values(),
            'page' => $page->currentPage(),
            'perPage' => $page->perPage(),
            'total' => $page->total(),
        ]);
    }

    /** The "hot products" strip (also used inside the chat app). */
    public function hot(): JsonResponse
    {
        $items = Product::query()->visible()->where('is_hot', true)->where('stock', '>', 0)
            ->with(['store', 'category'])->orderByDesc('id')->limit(12)->get();

        return response()->json($items->map(fn (Product $p) => Json::product($p))->values());
    }

    public function product(string $slug): JsonResponse
    {
        $product = Product::query()->visible()->with(['store', 'category'])->where('slug', $slug)->firstOrFail();

        return response()->json(Json::product($product));
    }

    public function store(string $slug): JsonResponse
    {
        $store = Store::query()->where('status', 'active')->where('slug', $slug)->firstOrFail();
        $products = $store->products()->visible()->with(['store', 'category'])->orderByDesc('id')->limit(60)->get();

        return response()->json([
            'id' => $store->id, 'name' => $store->name, 'slug' => $store->slug, 'description' => $store->description,
            'products' => $products->map(fn (Product $p) => Json::product($p))->values(),
        ]);
    }
}
