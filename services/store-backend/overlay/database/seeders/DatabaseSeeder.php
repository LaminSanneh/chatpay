<?php

namespace Database\Seeders;

use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\Artisan;

class DatabaseSeeder extends Seeder
{
    /** Same demo data as `php artisan store:seed-demo` (the default Laravel seeder would need a password column we do not have). */
    public function run(): void
    {
        Artisan::call('store:seed-demo');
    }
}
