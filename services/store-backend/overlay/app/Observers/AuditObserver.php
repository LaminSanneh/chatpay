<?php

namespace App\Observers;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;

/** Records catalog edits (products, categories, stores) with the signed-in back-office user as the actor. */
class AuditObserver
{
    public function created(Model $model): void
    {
        $this->log('created', $model, $model->getAttributes());
    }

    public function updated(Model $model): void
    {
        $changes = collect($model->getChanges())->except('updated_at')->map(fn ($new, $key) => ['from' => $model->getOriginal($key), 'to' => $new])->all();
        if ($changes !== []) {
            $this->log('updated', $model, $changes);
        }
    }

    public function deleted(Model $model): void
    {
        $this->log('deleted', $model, null);
    }

    private function log(string $action, Model $model, ?array $changes): void
    {
        $user = auth()->user();
        DB::table('catalog_audit_log')->insert([
            'actor_id' => $user?->getAuthIdentifier(),
            'actor_name' => $user?->name,
            'action' => $action,
            'subject_type' => strtolower(class_basename($model)),
            'subject_id' => (string) $model->getKey(),
            'changes' => $changes === null ? null : json_encode($changes),
            'created_at' => now(),
        ]);
    }
}
