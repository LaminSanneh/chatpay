<?php

namespace App\Models;

use Filament\Models\Contracts\FilamentUser;
use Filament\Models\Contracts\HasName;
use Filament\Panel;
use Illuminate\Database\Eloquent\Relations\HasOne;
use Illuminate\Foundation\Auth\User as Authenticatable;

/** A Keycloak identity as seen by the back office. Created/updated at sign-in; roles come from the token. */
class User extends Authenticatable implements FilamentUser, HasName
{
    public $incrementing = false;
    protected $keyType = 'string';
    protected $fillable = ['id', 'name', 'username', 'email', 'roles'];

    protected function casts(): array
    {
        return ['roles' => 'array'];
    }

    public function hasRole(string $role): bool
    {
        return in_array($role, $this->roles ?? [], true);
    }

    public function store(): HasOne
    {
        return $this->hasOne(Store::class, 'owner_user_id');
    }

    public function canAccessPanel(Panel $panel): bool
    {
        return match ($panel->getId()) {
            'admin' => $this->hasRole('catalog-admin') || $this->hasRole('wallet-admin'),
            // Owning a store that has been approved (active) or later suspended: no separate Keycloak role to hand out.
            'vendor' => $this->store()->whereIn('status', ['active', 'suspended'])->exists(),
            default => false,
        };
    }

    public function getFilamentName(): string
    {
        return $this->name ?: ($this->username ?: $this->id);
    }
}
