<?php

namespace App\Support;

class Money
{
    /** 2500 -> "D25.00". Amounts are integer minor units everywhere; this is for display only. */
    public static function format(int|string|null $minor, string $currency = 'GMD'): string
    {
        $symbol = $currency === 'GMD' ? 'D' : $currency.' ';

        return $symbol.number_format(((int) $minor) / 100, 2);
    }
}
