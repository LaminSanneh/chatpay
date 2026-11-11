<?php

namespace App\Messaging;

/** Throw this from a handler when retrying can never help. */
final class PermanentFailure extends \RuntimeException
{
}
