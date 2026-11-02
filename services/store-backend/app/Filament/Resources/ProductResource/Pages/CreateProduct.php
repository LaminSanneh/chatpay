<?php

namespace App\Filament\Resources\ProductResource\Pages;

use App\Filament\Resources\ProductResource;
use App\Support\Panels;
use Filament\Resources\Pages\CreateRecord;

class CreateProduct extends CreateRecord
{
    protected static string $resource = ProductResource::class;

    protected function mutateFormDataBeforeCreate(array $data): array
    {
        if (Panels::isVendor()) {
            $data['store_id'] = Panels::myStoreId();   // a vendor can only ever create products in their own store
        }
        $data['currency'] = config('store.currency');

        return $data;
    }
}
