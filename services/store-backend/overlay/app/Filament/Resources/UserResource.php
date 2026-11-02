<?php

namespace App\Filament\Resources;

use App\Filament\Resources\UserResource\Pages;
use App\Models\User;
use App\Services\WalletAdminClient;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Resources\Resource;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;

/** People who have signed in to the back office. Finance staff can look up a person's wallet (the lookup is audited by the wallet). */
class UserResource extends Resource
{
    protected static ?string $model = User::class;
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedUsers;

    public static function canCreate(): bool
    {
        return false;
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->searchable(),
                TextColumn::make('username')->searchable(),
                TextColumn::make('roles')->badge()->separator(','),
                TextColumn::make('store.name')->label('Store')->placeholder('-'),
            ])
            ->recordActions([
                Action::make('wallet')->label('Wallet')->icon(Heroicon::Banknotes)
                    ->visible(fn () => auth()->user()?->hasRole('wallet-admin') ?? false)
                    ->modalHeading(fn (User $record) => 'Wallet: '.($record->name ?? $record->username))
                    ->modalContent(fn (User $record) => view('filament.wallet-modal', ['data' => app(WalletAdminClient::class)->lookup($record->id)]))
                    ->modalSubmitAction(false)
                    ->modalCancelActionLabel('Close'),
            ]);
    }

    public static function getPages(): array
    {
        return ['index' => Pages\ListUsers::route('/')];
    }
}
