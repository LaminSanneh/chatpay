<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stores', function (Blueprint $table) {
            $table->id();
            $table->string('owner_user_id')->index();            // Keycloak sub; not a foreign key (identity lives in Keycloak)
            $table->string('name');
            $table->string('slug')->unique();
            $table->text('description')->nullable();
            $table->string('logo_path')->nullable();
            $table->string('status', 16)->default('pending');    // pending | active | suspended | closed
            $table->unsignedInteger('commission_bps')->nullable();
            $table->timestamps();
        });

        Schema::create('categories', function (Blueprint $table) {
            $table->id();
            $table->string('name');
            $table->string('slug')->unique();
            $table->timestamps();
        });

        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->foreignId('store_id')->constrained()->cascadeOnDelete();
            $table->foreignId('category_id')->nullable()->constrained()->nullOnDelete();
            $table->string('name');
            $table->string('slug')->unique();
            $table->text('description')->nullable();
            $table->unsignedBigInteger('price_minor');           // 100 = D1.00. Never floats for money.
            $table->string('currency', 3)->default('GMD');
            $table->integer('stock')->default(0);
            $table->string('status', 16)->default('draft');     // draft | active | archived
            $table->boolean('is_hot')->default(false);
            $table->string('image_path')->nullable();
            $table->timestamps();
            $table->index(['status', 'is_hot']);
        });

        Schema::create('orders', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('buyer_user_id')->index();
            $table->string('recipient_user_id')->nullable()->index();   // set for gifts
            $table->foreignId('store_id')->constrained();
            $table->string('status', 24)->default('pending_payment')->index();
            $table->unsignedBigInteger('total_minor');
            $table->string('currency', 3);
            $table->string('payment_intent_id')->nullable()->index();   // the wallet's ORDER intent
            $table->string('transfer_id')->nullable();
            $table->json('chat_context')->nullable();                   // {type: chat, roomId}
            $table->json('shipping')->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->timestamp('paid_at')->nullable();
            $table->timestamp('shipped_at')->nullable();
            $table->timestamp('delivered_at')->nullable();
            $table->timestamp('settled_at')->nullable();
            $table->timestamp('cancelled_at')->nullable();
            $table->timestamps();
        });

        Schema::create('order_items', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('order_id')->constrained()->cascadeOnDelete();
            $table->foreignId('product_id')->nullable()->constrained()->nullOnDelete();
            $table->string('name');                                     // snapshot: what was bought, at what price
            $table->unsignedBigInteger('unit_price_minor');
            $table->unsignedInteger('quantity');
            $table->string('image_url')->nullable();
            $table->timestamps();
        });

        // Transactional outbox: events are written in the same DB transaction as the change, then relayed to RabbitMQ.
        Schema::create('outbox_events', function (Blueprint $table) {
            $table->id();
            $table->string('exchange');
            $table->string('routing_key');
            $table->json('payload');
            $table->unsignedInteger('attempts')->default(0);
            $table->timestamp('published_at')->nullable();
            $table->timestamps();
            $table->index(['published_at', 'id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('outbox_events');
        Schema::dropIfExists('order_items');
        Schema::dropIfExists('orders');
        Schema::dropIfExists('products');
        Schema::dropIfExists('categories');
        Schema::dropIfExists('stores');
    }
};
