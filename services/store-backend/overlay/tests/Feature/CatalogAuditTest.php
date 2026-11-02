<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\StoreFixtures;
use Tests\TestCase;

class CatalogAuditTest extends TestCase
{
    use RefreshDatabase, StoreFixtures;

    public function test_catalog_edits_are_recorded_with_who_made_them(): void
    {
        $admin = $this->makeUser('33333333-3333-4333-8333-333333333333', ['catalog-admin']);
        $store = $this->makeStore();
        $this->actingAs($admin);

        $product = $this->makeProduct($store, ['slug' => 'mug', 'price_minor' => 2500]);
        $product->update(['price_minor' => 3000, 'stock' => 7]);
        $product->delete();

        $rows = DB::table('catalog_audit_log')->where('subject_type', 'product')->where('subject_id', (string) $product->id)->orderBy('id')->get();
        $this->assertSame(['created', 'updated', 'deleted'], $rows->pluck('action')->all());
        $this->assertSame([$admin->id, $admin->id, $admin->id], $rows->pluck('actor_id')->all());
        $changes = json_decode($rows[1]->changes, true);
        $this->assertSame(['from' => 2500, 'to' => 3000], $changes['price_minor']);
    }

    public function test_system_changes_have_no_actor(): void
    {
        $this->makeStore();

        $row = DB::table('catalog_audit_log')->where('subject_type', 'store')->first();
        $this->assertNotNull($row);
        $this->assertNull($row->actor_id);
    }

    public function test_an_update_that_changes_nothing_writes_nothing(): void
    {
        $product = $this->makeProduct($this->makeStore());
        $before = DB::table('catalog_audit_log')->count();

        $product->update(['name' => $product->name]);

        $this->assertSame($before, DB::table('catalog_audit_log')->count());
    }
}
