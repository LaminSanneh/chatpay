<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class OutboxEvent extends Model
{
    protected $fillable = ['exchange', 'routing_key', 'payload', 'attempts', 'published_at', 'failed_attempts', 'last_error'];

    protected function casts(): array
    {
        return ['payload' => 'array', 'published_at' => 'datetime', 'failed_attempts' => 'integer'];
    }
}
