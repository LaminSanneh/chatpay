<?php

namespace App\Services;

use RuntimeException;

class WalletException extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}
