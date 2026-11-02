<?php

namespace App\Filament\Resources;

use App\Exceptions\DomainError;
use App\Filament\Resources\OrderResource\Pages;
use App\Models\Order;
use App\Services\OrderService;
use App\Services\WalletException;
use App\Support\Money;
use App\Support\Panels;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

/**
 * Orders. Vendors see their store's orders and mark them shipped/delivered. Admins can also pay out or refund.
 * Money never moves here directly: payout and refund are requests to the wallet (escrow release/refund).
 */
class OrderResource extends Resource
{
    protected static ?string $model = Order::class;
    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedClipboardDocumentList;

    public static function canCreate(): bool
    {
        return false;
    }

    public static function getEloquentQuery(): Builder
    {
        $query = parent::getEloquentQuery()->with(['items', 'store']);

        return Panels::isVendor() ? $query->where('store_id', Panels::myStoreId() ?? 0) : $query;
    }

    public static function table(Table $table): Table
    {
        return $table
            ->defaultSort('created_at', 'desc')
            ->columns([
                TextColumn::make('id')->label('Order')->formatStateUsing(fn ($state) => substr($state, 0, 8))->searchable(),
                TextColumn::make('store.name')->visible(fn () => ! Panels::isVendor()),
                TextColumn::make('items_summary')->label('Items')->state(
                    fn (Order $r) => $r->items->map(fn ($i) => $i->quantity.' × '.$i->name)->join(', '))->wrap(),
                TextColumn::make('total_minor')->label('Total')->sortable()->formatStateUsing(fn ($state, Order $r) => Money::format($state, $r->currency)),
                TextColumn::make('status')->badge()->color(fn (string $state) => match ($state) {
                    Order::PAID, Order::SHIPPED => 'info', Order::DELIVERED, Order::COMPLETED => 'success',
                    Order::PENDING => 'gray', Order::REVIEW => 'danger', default => 'warning',
                }),
                TextColumn::make('recipient_user_id')->label('Gift')->formatStateUsing(fn ($state) => $state ? 'Yes' : '')->toggleable(),
                TextColumn::make('created_at')->dateTime()->sortable(),
            ])
            ->filters([SelectFilter::make('status')->options([
                Order::PENDING => 'Pending payment', Order::PAID => 'Paid', Order::SHIPPED => 'Shipped', Order::DELIVERED => 'Delivered',
                Order::COMPLETED => 'Completed', Order::CANCELLED => 'Cancelled', Order::REFUNDED => 'Refunded', Order::REVIEW => 'Needs review',
            ])])
            ->recordActions([
                self::step('ship', 'Mark shipped', Heroicon::Truck, [Order::PAID], fn (Order $r) => app(OrderService::class)->ship($r)),
                self::step('deliver', 'Mark delivered', Heroicon::CheckBadge, [Order::SHIPPED], fn (Order $r) => app(OrderService::class)->deliver($r)),
                self::step('payout', 'Pay out now', Heroicon::Banknotes, [Order::DELIVERED], fn (Order $r) => app(OrderService::class)->settle($r), adminOnly: true, confirm: true),
                self::step('refund', 'Refund buyer', Heroicon::ArrowUturnLeft, [Order::PAID, Order::SHIPPED, Order::REVIEW], fn (Order $r) => app(OrderService::class)->refund($r), adminOnly: true, confirm: true, color: 'danger'),
            ]);
    }

    /** A row action that runs an OrderService transition and reports wallet/business errors as notifications. */
    private static function step(string $name, string $label, Heroicon $icon, array $from, callable $run, bool $adminOnly = false, bool $confirm = false, string $color = 'primary'): Action
    {
        $action = Action::make($name)->label($label)->icon($icon)->color($color)
            ->visible(fn (Order $r) => in_array($r->status, $from, true) && ! ($adminOnly && Panels::isVendor()))
            ->action(function (Order $record) use ($run, $label) {
                try {
                    $run($record);
                    Notification::make()->title("{$label}: done")->success()->send();
                } catch (DomainError|WalletException $e) {
                    Notification::make()->title("{$label} failed")->body($e->getMessage())->danger()->send();
                }
            });

        return $confirm ? $action->requiresConfirmation() : $action;
    }

    public static function getPages(): array
    {
        return ['index' => Pages\ListOrders::route('/')];
    }
}
