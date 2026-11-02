<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Facades\Storage;

class Product extends Model
{
    protected $fillable = ['store_id', 'category_id', 'name', 'slug', 'description', 'price_minor', 'currency', 'stock', 'status', 'is_hot', 'image_path'];

    protected function casts(): array
    {
        return ['price_minor' => 'integer', 'stock' => 'integer', 'is_hot' => 'boolean'];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function category(): BelongsTo
    {
        return $this->belongsTo(Category::class);
    }

    /** What shoppers may see: active products of active stores. */
    public function scopeVisible(Builder $query): Builder
    {
        return $query->where('status', 'active')->whereHas('store', fn (Builder $s) => $s->where('status', 'active'));
    }

    protected function imageUrl(): Attribute
    {
        return Attribute::get(fn () => $this->image_path ? Storage::disk('public')->url($this->image_path) : null);
    }
}
