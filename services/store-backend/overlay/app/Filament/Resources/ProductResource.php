<?php

namespace App\Filament\Resources;

use App\Filament\Resources\ProductResource\Pages;
use App\Models\Product;
use App\Models\Store;
use App\Support\Money;
use App\Support\Panels;
use BackedEnum;
use Filament\Actions\BulkActionGroup;
use Filament\Actions\DeleteBulkAction;
use Filament\Actions\EditAction;
use Filament\Forms\Components\FileUpload;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Resources\Resource;
use Filament\Schemas\Components\Utilities\Set;
use Filament\Schemas\Schema;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\IconColumn;
use Filament\Tables\Columns\ImageColumn;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Str;

class ProductResource extends Resource
{
    protected static ?string $model = Product::class;
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedShoppingBag;

    /** Vendors see and edit only their own store's products. */
    public static function getEloquentQuery(): Builder
    {
        $query = parent::getEloquentQuery();

        return Panels::isVendor() ? $query->where('store_id', Panels::myStoreId() ?? 0) : $query;
    }

    public static function form(Schema $schema): Schema
    {
        return $schema->components([
            Select::make('store_id')->label('Store')->options(fn () => Store::query()->pluck('name', 'id'))
                ->searchable()->required()->visible(fn () => ! Panels::isVendor()),
            TextInput::make('name')->required()->maxLength(160)->live(onBlur: true)
                ->afterStateUpdated(fn ($state, Set $set) => $set('slug', Str::slug((string) $state))),
            TextInput::make('slug')->required()->maxLength(180)->unique(ignoreRecord: true),
            Select::make('category_id')->relationship('category', 'name')->searchable()->preload(),
            Textarea::make('description')->rows(4),
            // Shown in dalasi, stored as integer butut (minor units): no floating point ever reaches the database.
            TextInput::make('price_minor')->label('Price')->numeric()->prefix('D')->required()->minValue(0.01)
                ->formatStateUsing(fn ($state) => $state === null ? null : $state / 100)
                ->dehydrateStateUsing(fn ($state) => (int) round(((float) $state) * 100)),
            TextInput::make('stock')->numeric()->integer()->required()->minValue(0)->default(0),
            Select::make('status')->options(['draft' => 'Draft', 'active' => 'Active', 'archived' => 'Archived'])->required()->default('draft'),
            Toggle::make('is_hot')->label('Show in "hot products"'),
            FileUpload::make('image_path')->label('Image')->image()->disk('public')->directory('products'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                ImageColumn::make('image_path')->label('')->disk('public')->square(),
                TextColumn::make('name')->searchable()->sortable(),
                TextColumn::make('store.name')->visible(fn () => ! Panels::isVendor()),
                TextColumn::make('price_minor')->label('Price')->sortable()->formatStateUsing(fn ($state) => Money::format($state)),
                TextColumn::make('stock')->sortable(),
                TextColumn::make('status')->badge()->color(fn (string $state) => match ($state) {
                    'active' => 'success', 'draft' => 'gray', default => 'warning',
                }),
                IconColumn::make('is_hot')->boolean()->label('Hot'),
            ])
            ->recordActions([EditAction::make()])
            ->toolbarActions([BulkActionGroup::make([DeleteBulkAction::make()])]);
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListProducts::route('/'),
            'create' => Pages\CreateProduct::route('/create'),
            'edit' => Pages\EditProduct::route('/{record}/edit'),
        ];
    }
}
