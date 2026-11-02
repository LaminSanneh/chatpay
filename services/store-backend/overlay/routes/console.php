<?php

use Illuminate\Support\Facades\Schedule;

// Run `php artisan schedule:work` in development.
Schedule::command('orders:expire')->everyMinute();
Schedule::command('orders:settle')->everyFiveMinutes();
