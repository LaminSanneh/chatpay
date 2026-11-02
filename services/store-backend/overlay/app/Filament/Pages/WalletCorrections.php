<?php

namespace App\Filament\Pages;

use App\Services\WalletAdminClient;
use App\Services\WalletException;
use App\Support\Money;
use BackedEnum;
use Filament\Actions\Action;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\Textarea;
use Filament\Forms\Components\TextInput;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Filament\Support\Icons\Heroicon;
use Filament\Tables\Columns\TextColumn;
use Filament\Tables\Concerns\InteractsWithTable;
use Filament\Tables\Contracts\HasTable;
use Filament\Tables\Filters\SelectFilter;
use Filament\Tables\Table;

/**
 * Finance corrections. There is no way to edit or delete money history here, only to REQUEST an append-only
 * correction; a DIFFERENT admin then approves it. All data comes from the wallet's admin API using the signed-in
 * admin's own token, so the wallet attributes (and authorizes) every action.
 */
class WalletCorrections extends Page implements HasTable
{
    use InteractsWithTable;

    protected static string|BackedEnum|null $navigationIcon = Heroicon::OutlinedShieldCheck;
    protected static ?string $navigationLabel = 'Wallet corrections';
    protected string $view = 'filament.pages.wallet-corrections';

    public static function canAccess(): bool
    {
        return auth()->user()?->hasRole('wallet-admin') ?? false;
    }

    public function table(Table $table): Table
    {
        return $table
            ->records(function (array $filters): array {
                try {
                    $status = $filters['status']['value'] ?? 'PENDING';

                    return collect(app(WalletAdminClient::class)->actions($status))->keyBy('id')->all();
                } catch (WalletException $e) {
                    Notification::make()->title('Wallet unavailable')->body($e->getMessage())->danger()->send();

                    return [];
                }
            })
            ->columns([
                TextColumn::make('type')->badge(),
                TextColumn::make('status')->badge()->color(fn (string $state) => match ($state) { 'APPROVED' => 'success', 'REJECTED' => 'danger', default => 'warning' }),
                TextColumn::make('direction')->placeholder('-'),
                TextColumn::make('amountMinor')->label('Amount')->formatStateUsing(fn ($state, $record) => Money::format($state, $record['currency'])),
                TextColumn::make('reasonCode')->label('Reason code'),
                TextColumn::make('reason')->wrap(),
                TextColumn::make('createdBy')->label('Requested by')->limit(12),
            ])
            ->filters([SelectFilter::make('status')->options(['PENDING' => 'Pending', 'APPROVED' => 'Approved', 'REJECTED' => 'Rejected'])->default('PENDING')])
            ->recordActions([
                $this->decision('approve', 'Approve', Heroicon::Check, 'success', fn ($id, $note) => app(WalletAdminClient::class)->approve($id, $note)),
                $this->decision('reject', 'Reject', Heroicon::XMark, 'danger', fn ($id, $note) => app(WalletAdminClient::class)->reject($id, $note)),
            ]);
    }

    /** Approve/Reject for a pending row. The wallet refuses an approval from the person who requested the action. */
    private function decision(string $name, string $label, Heroicon $icon, string $color, callable $call): Action
    {
        return Action::make($name)->label($label)->icon($icon)->color($color)
            ->visible(fn (array $record) => $record['status'] === 'PENDING')
            ->schema([Textarea::make('note')->label('Note (optional)')->maxLength(500)])
            ->requiresConfirmation()
            ->action(function (array $record, array $data) use ($call, $label) {
                try {
                    $call($record['id'], $data['note'] ?? null);
                    Notification::make()->title("{$label}d")->success()->send();
                } catch (WalletException $e) {
                    Notification::make()->title("{$label} failed")->body($e->errorCode.': '.$e->getMessage())->danger()->send();
                }
                $this->resetTable();
            });
    }

    protected function getHeaderActions(): array
    {
        return [
            Action::make('adjust')->label('Request adjustment')->icon(Heroicon::PlusCircle)
                ->schema([
                    TextInput::make('accountId')->label('Wallet account id')->uuid()->required(),
                    Select::make('direction')->options(['CREDIT' => 'Credit (add money)', 'DEBIT' => 'Debit (take money)'])->required(),
                    TextInput::make('amount')->numeric()->prefix('D')->minValue(0.01)->required(),
                    TextInput::make('reasonCode')->maxLength(32)->required(),
                    Textarea::make('reason')->maxLength(500)->required(),
                ])
                ->action(fn (array $data) => $this->request(fn () => app(WalletAdminClient::class)->requestAdjustment([
                    'accountId' => $data['accountId'], 'direction' => $data['direction'], 'amountMinor' => (int) round($data['amount'] * 100),
                    'reasonCode' => $data['reasonCode'], 'reason' => $data['reason'],
                ]))),

            Action::make('reverse')->label('Request transfer reversal')->icon(Heroicon::ArrowUturnLeft)
                ->schema([
                    TextInput::make('transferId')->label('Transfer id')->uuid()->required(),
                    TextInput::make('reasonCode')->maxLength(32)->required(),
                    Textarea::make('reason')->maxLength(500)->required(),
                ])
                ->action(fn (array $data) => $this->request(fn () => app(WalletAdminClient::class)->requestReversal(
                    $data['transferId'], ['reasonCode' => $data['reasonCode'], 'reason' => $data['reason']]))),

            Action::make('reconcile')->label('Run reconciliation')->icon(Heroicon::Scale)->color('gray')
                ->action(function () {
                    try {
                        $bad = app(WalletAdminClient::class)->reconciliation();
                        $bad === []
                            ? Notification::make()->title('Books are consistent')->body('Every balance matches its ledger entries.')->success()->send()
                            : Notification::make()->title(count($bad).' account(s) out of balance')->body(json_encode($bad))->danger()->persistent()->send();
                    } catch (WalletException $e) {
                        Notification::make()->title('Reconciliation failed')->body($e->getMessage())->danger()->send();
                    }
                }),
        ];
    }

    private function request(callable $call): void
    {
        try {
            $call();
            Notification::make()->title('Requested: a different admin must approve it')->success()->send();
        } catch (WalletException $e) {
            Notification::make()->title('Request failed')->body($e->errorCode.': '.$e->getMessage())->danger()->send();
        }
        $this->resetTable();
    }
}
