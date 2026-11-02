<?php

namespace App\Console\Commands;

use App\Models\Category;
use App\Models\Product;
use App\Models\Store;
use App\Models\User;
use Illuminate\Console\Command;

/** Demo data. User ids match infra/keycloak/chatpay-realm.json (Keycloak keeps ids given in an import). */
class SeedDemo extends Command
{
    protected $signature = 'store:seed-demo';
    protected $description = 'Create demo categories, a store owned by bob, and a few products';

    public function handle(): int
    {
        $bob = '22222222-2222-4222-8222-222222222222';
        User::updateOrCreate(['id' => $bob], ['name' => 'Bob Test', 'username' => 'bob', 'roles' => ['vendor']]);
        User::updateOrCreate(['id' => '33333333-3333-4333-8333-333333333333'], ['name' => 'Catalog Admin Test', 'username' => 'admin1', 'roles' => ['catalog-admin']]);

        $cats = collect(['Home' => 'home', 'Electronics' => 'electronics', 'Fashion' => 'fashion'])
            ->map(fn ($slug, $name) => Category::firstOrCreate(['slug' => $slug], ['name' => $name]));

        // Creating the store as active publishes store.opened (the chat then shows the store icon next to bob).
        $store = Store::firstOrCreate(['slug' => 'bobs-shop'], [
            'owner_user_id' => $bob, 'name' => "Bob's Shop", 'description' => 'Everyday things, delivered.', 'status' => 'active',
        ]);

        $products = [
            ['Ceramic mug', 'ceramic-mug', 'Home', 25_00, 40, true],
            ['Wireless earbuds', 'wireless-earbuds', 'Electronics', 450_00, 12, true],
            ['Cotton t-shirt', 'cotton-t-shirt', 'Fashion', 180_00, 30, true],
            ['Desk lamp', 'desk-lamp', 'Home', 220_00, 8, false],
            ['Phone charger', 'phone-charger', 'Electronics', 90_00, 50, true],
            ['Canvas tote bag', 'canvas-tote-bag', 'Fashion', 75_00, 25, false],
        ];
        foreach ($products as [$name, $slug, $category, $price, $stock, $hot]) {
            Product::firstOrCreate(['slug' => $slug], [
                'store_id' => $store->id, 'category_id' => $cats[$category]->id, 'name' => $name,
                'description' => "{$name} from Bob's Shop.", 'price_minor' => $price, 'stock' => $stock, 'status' => 'active', 'is_hot' => $hot,
            ]);
        }

        $this->info('Seeded: store "bobs-shop" with '.count($products).' products.');

        return self::SUCCESS;
    }
}
