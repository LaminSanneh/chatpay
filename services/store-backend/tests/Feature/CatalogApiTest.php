<?php

namespace Tests\Feature;

use App\Models\Category;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

class CatalogApiTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    public function test_shoppers_only_see_active_products_of_active_stores(): void
    {
        $open = $this->makeStore();
        $closed = $this->makeStore(['slug' => 'closed', 'name' => 'Closed', 'status' => 'suspended', 'owner_user_id' => $this->carol]);
        $this->makeProduct($open, ['slug' => 'mug', 'name' => 'Mug']);
        $this->makeProduct($open, ['slug' => 'draft', 'status' => 'draft']);
        $this->makeProduct($closed, ['slug' => 'hidden']);

        $slugs = collect($this->getJson('/api/v1/products')->assertOk()->json('items'))->pluck('slug')->all();

        $this->assertSame(['mug'], $slugs);
        $this->getJson('/api/v1/products/draft')->assertNotFound();
        $this->getJson('/api/v1/products/hidden')->assertNotFound();
        $this->getJson('/api/v1/products/mug')->assertOk()->assertJsonPath('name', 'Mug');
    }

    public function test_prices_are_integer_minor_units(): void
    {
        $this->makeProduct($this->makeStore(), ['slug' => 'mug', 'price_minor' => 2550]);

        $price = $this->getJson('/api/v1/products/mug')->json('priceMinor');

        $this->assertSame(2550, $price);
    }

    public function test_search_matches_name_or_description_case_insensitively(): void
    {
        $store = $this->makeStore();
        $this->makeProduct($store, ['slug' => 'mug', 'name' => 'Ceramic Mug']);
        $this->makeProduct($store, ['slug' => 'lamp', 'name' => 'Desk lamp', 'description' => 'Bright light for a desk']);

        $byName = collect($this->getJson('/api/v1/products?search=MUG')->json('items'))->pluck('slug')->all();
        $byDescription = collect($this->getJson('/api/v1/products?search=bright')->json('items'))->pluck('slug')->all();

        $this->assertSame(['mug'], $byName);
        $this->assertSame(['lamp'], $byDescription);
    }

    public function test_filters_by_category_and_store(): void
    {
        $home = Category::create(['name' => 'Home', 'slug' => 'home']);
        $mine = $this->makeStore();
        $other = $this->makeStore(['slug' => 'other', 'name' => 'Other', 'owner_user_id' => $this->carol]);
        $this->makeProduct($mine, ['slug' => 'mug', 'category_id' => $home->id]);
        $this->makeProduct($mine, ['slug' => 'shirt']);
        $this->makeProduct($other, ['slug' => 'vase', 'category_id' => $home->id]);

        $inHome = collect($this->getJson('/api/v1/products?category=home')->json('items'))->pluck('slug')->sort()->values()->all();
        $inOther = collect($this->getJson('/api/v1/products?store=other')->json('items'))->pluck('slug')->all();

        $this->assertSame(['mug', 'vase'], $inHome);
        $this->assertSame(['vase'], $inOther);
    }

    public function test_hot_products_must_be_flagged_and_in_stock(): void
    {
        $store = $this->makeStore();
        $this->makeProduct($store, ['slug' => 'hot', 'is_hot' => true]);
        $this->makeProduct($store, ['slug' => 'sold-out', 'is_hot' => true, 'stock' => 0]);
        $this->makeProduct($store, ['slug' => 'plain']);

        $slugs = collect($this->getJson('/api/v1/products/hot')->assertOk()->json())->pluck('slug')->all();

        $this->assertSame(['hot'], $slugs);
    }

    public function test_store_page_shows_active_stores_only(): void
    {
        $this->makeProduct($this->makeStore(), ['slug' => 'mug']);
        $this->makeStore(['slug' => 'gone', 'name' => 'Gone', 'status' => 'suspended', 'owner_user_id' => $this->carol]);

        $this->getJson('/api/v1/stores/bobs-shop')->assertOk()->assertJsonCount(1, 'products');
        $this->getJson('/api/v1/stores/gone')->assertNotFound();
    }
}
