<?php

namespace App\Providers\Filament;

use App\Filament\Http\KeycloakAuthenticate;
use App\Http\Middleware\SyncBackOfficeAccess;
use App\Filament\Resources\OrderResource;
use App\Filament\Resources\ProductResource;
use App\Filament\Resources\StoreResource;
use Filament\Actions\Action;
use Filament\Pages\Dashboard;
use Filament\Panel;
use Filament\PanelProvider;
use Filament\Support\Colors\Color;

/** /vendor: store owners (role vendor + a store). The shared resources scope themselves to the owner's store. */
class VendorPanelProvider extends PanelProvider
{
    use PanelDefaults;

    public function panel(Panel $panel): Panel
    {
        return $panel
            ->id('vendor')
            ->path('vendor')
            ->brandName('ChatPay Store · My store')
            ->colors(['primary' => Color::Emerald])
            ->resources([ProductResource::class, OrderResource::class, StoreResource::class])
            ->pages([Dashboard::class])
            ->userMenuItems(['logout' => Action::make('logout')->label('Sign out')->url('/auth/logout')])
            ->middleware($this->baseMiddleware())
            ->authMiddleware([KeycloakAuthenticate::class, SyncBackOfficeAccess::class]);
    }
}
