<?php

namespace App\Filament\Resources;

use App\Filament\Resources\StoreResource\Pages;
use App\Models\Store;
use App\Models\User;
use App\Support\Panels;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Actions\EditAction;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Resources\Resource;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/**
 * Admins create stores and decide whether they are open (an active store is announced to the chat app: store icon).
 * Vendors can only edit their own store's profile.
 */
class StoreResource extends Resource
{
    protected static ?string $model = Store::class;
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedBuildingStorefront;

    public static function getEloquentQuery(): Builder
    {
        $query = parent::getEloquentQuery();

        return Panels::isVendor() ? $query->where('owner_user_id', auth()->id()) : $query;
    }

    public static function canCreate(): bool
    {
        return ! Panels::isVendor();
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            Select::make('owner_user_id')->label('Owner')->options(fn () => User::query()->pluck('name', 'id'))
                ->searchable()->required()->visible(fn () => ! Panels::isVendor()),
            TextInput::make('name')->required()->maxLength(120),
            TextInput::make('slug')->required()->maxLength(140)->unique(ignoreRecord: true)->disabled(fn () => Panels::isVendor()),
            Textarea::make('description')->rows(3),
            FileUpload::make('logo_path')->label('Logo')->image()->disk('public')->directory('stores'),
            Select::make('status')->options(['pending' => 'Pending', 'active' => 'Active', 'suspended' => 'Suspended', 'closed' => 'Closed'])
                ->required()->default('pending')->visible(fn () => ! Panels::isVendor()),
            TextInput::make('commission_bps')->label('Commission override (basis points, 1000 = 10%)')->numeric()->minValue(0)->maxValue(5000)
                ->visible(fn () => ! Panels::isVendor()),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                TextColumn::make('name')->searchable()->sortable(),
                TextColumn::make('owner.name')->label('Owner')->placeholder('(not signed in yet)'),
                TextColumn::make('status')->badge()->color(fn (string $state) => match ($state) {
                    'active' => 'success', 'pending' => 'warning', default => 'danger',
                }),
                TextColumn::make('commission_bps')->label('Commission')->formatStateUsing(fn ($state) => $state === null ? 'default' : ($state / 100).'%'),
            ])
            ->recordActions([
                Action::make('activate')->icon(Heroicon::CheckCircle)->color('success')->requiresConfirmation()
                    ->visible(fn (Store $record) => ! Panels::isVendor() && ! $record->isActive())
                    ->action(fn (Store $record) => $record->update(['status' => 'active'])),
                Action::make('suspend')->icon(Heroicon::NoSymbol)->color('danger')->requiresConfirmation()
                    ->visible(fn (Store $record) => ! Panels::isVendor() && $record->isActive())
                    ->action(fn (Store $record) => $record->update(['status' => 'suspended'])),
                EditAction::make(),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListStores::route('/'),
            'create' => Pages\CreateStore::route('/create'),
            'edit' => Pages\EditStore::route('/{record}/edit'),
        ];
    }
}
