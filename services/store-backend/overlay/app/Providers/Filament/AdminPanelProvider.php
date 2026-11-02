<?php

namespace App\Providers\Filament;

use App\Filament\Http\KeycloakAuthenticate;
use App\Http\Middleware\SyncBackOfficeAccess;
use App\Filament\Pages\WalletCorrections;
use App\Filament\Resources\CategoryResource;
use App\Filament\Resources\OrderResource;
use App\Filament\Resources\ProductResource;
use App\Filament\Resources\StoreResource;
use App\Filament\Resources\UserResource;
use Filament\Actions\Action;
use Filament\Pages\Dashboard;
use Filament\Panel;
use Filament\PanelProvider;
use Filament\Support\Colors\Color;

/** /admin: platform staff (roles catalog-admin and/or wallet-admin). */
class AdminPanelProvider extends PanelProvider
{
    use PanelDefaults;

    public function panel(Panel $panel): Panel
    {
        return $panel
            ->id('admin')
            ->path('admin')
            ->default()
            ->brandName('ChatPay Store · Back office')
            ->colors(['primary' => Color::Amber])
            ->resources([ProductResource::class, CategoryResource::class, StoreResource::class, OrderResource::class, UserResource::class])
            ->pages([Dashboard::class, WalletCorrections::class])
            ->userMenuItems(['logout' => Action::make('logout')->label('Sign out')->url('/auth/logout')])
            ->middleware($this->baseMiddleware())
            ->authMiddleware([KeycloakAuthenticate::class, SyncBackOfficeAccess::class]);
    }
}
