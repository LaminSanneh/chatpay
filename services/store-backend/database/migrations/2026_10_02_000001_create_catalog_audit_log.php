<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Who changed what in the catalog, and when. Insert-only by convention (nothing in the app updates or deletes rows).
        Schema::create('catalog_audit_log', function (Blueprint $table) {
            $table->id();
            $table->string('actor_id')->nullable()->index();   // Keycloak sub of the back-office user, null for system changes
            $table->string('actor_name')->nullable();
            $table->string('action', 16);                      // created | updated | deleted
            $table->string('subject_type', 32);                // product | category | store
            $table->string('subject_id', 64);
            $table->json('changes')->nullable();
            $table->timestamp('created_at')->useCurrent();
            $table->index(['subject_type', 'subject_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('catalog_audit_log');
    }
};
