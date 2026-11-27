<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Why an outbox row has not been published: how often publishing it failed, and the latest error. Until now a failing row just
        // stayed unpublished with no trace. failed_attempts is kept as history after a later success; last_error is cleared by it.
        Schema::table('outbox_events', function (Blueprint $table) {
            $table->unsignedInteger('failed_attempts')->default(0)->after('attempts');
            $table->text('last_error')->nullable()->after('failed_attempts');
        });
    }

    public function down(): void
    {
        Schema::table('outbox_events', function (Blueprint $table) {
            $table->dropColumn(['failed_attempts', 'last_error']);
        });
    }
};
