<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;

abstract class TestCase extends BaseTestCase
{
    /**
     * The tests use RefreshDatabase, which runs `migrate:fresh`: DROPS EVERY TABLE of whatever database the app points at. They are meant to run on
     * SQLite in memory (phpunit.xml). If something overrides that (DB_* exported in the shell, a cached config, a .env.testing) the app would
     * silently point at the development database, so refuse to start instead of wiping it.
     */
    public function createApplication()
    {
        $app = parent::createApplication();

        $connection = $app['config']->get('database.default');
        $database = $app['config']->get("database.connections.{$connection}.database");
        if ($connection !== 'sqlite' || $database !== ':memory:') {
            throw new \RuntimeException(
                "Refusing to run the tests against the '{$connection}' connection (database '{$database}'): RefreshDatabase would wipe it. ".
                'They must run on sqlite :memory: (phpunit.xml). Look for DB_CONNECTION/DB_DATABASE/DB_URL exported in your shell (`env | grep ^DB_`), '.
                'a cached config (`php artisan config:clear`) or a .env.testing file.'
            );
        }

        return $app;
    }
}
