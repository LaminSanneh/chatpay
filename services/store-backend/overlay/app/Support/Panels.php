<?php

namespace App\Support;

use Filament\Facades\Filament;

/** Products, stores and orders are shared by both panels; the vendor panel only ever sees the signed-in vendor's own store. */
class Panels
{
    public static function isVendor(): bool
    {
        return Filament::getCurrentPanel()?->getId() === 'vendor';
    }

    public static function myStoreId(): ?int
    {
        return auth()->user()?->store?->id;
    }
}
