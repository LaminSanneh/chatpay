@php use App\Support\Money; @endphp
<div class="space-y-4 text-sm">
    @if ($data['error'])
        <p class="text-danger-600">{{ $data['error'] }}</p>
    @else
        <div>
            <div class="text-gray-500">Balance</div>
            <div class="text-2xl font-semibold">{{ Money::format($data['wallet']['balanceMinor'], $data['wallet']['currency']) }}</div>
            <div class="text-xs text-gray-500">Account {{ $data['wallet']['accountId'] }}</div>
        </div>

        <div>
            <div class="font-medium">Latest ledger entries</div>
            <table class="w-full">
                @forelse ($data['entries']['items'] as $e)
                    <tr class="border-t">
                        <td class="py-1">{{ $e['kind'] }} <span class="text-gray-500">{{ $e['description'] }}</span></td>
                        <td class="py-1 text-right">{{ $e['direction'] === 'CREDIT' ? '+' : '−' }}{{ Money::format($e['amountMinor'], $e['currency']) }}</td>
                        <td class="py-1 text-right text-gray-500">{{ isset($e['balanceAfter']) ? Money::format($e['balanceAfter'], $e['currency']) : '' }}</td>
                    </tr>
                @empty
                    <tr><td class="py-1 text-gray-500">No entries.</td></tr>
                @endforelse
            </table>
        </div>

        <div>
            <div class="font-medium">Recent transfers</div>
            <table class="w-full">
                @forelse ($data['transfers'] as $t)
                    <tr class="border-t">
                        <td class="py-1">{{ $t['kind'] }} <span class="text-gray-500">{{ $t['id'] }}</span></td>
                        <td class="py-1 text-right">{{ Money::format($t['amountMinor'], $t['currency']) }}</td>
                    </tr>
                @empty
                    <tr><td class="py-1 text-gray-500">No transfers.</td></tr>
                @endforelse
            </table>
        </div>
    @endif
</div>
