#!/usr/bin/env bash
# Builds the store backend: fetches a fresh Laravel skeleton, adds our code on top (overlay/), installs
# Filament + the AMQP and JWT libraries, migrates, seeds and runs the test suite. Safe to re-run.
#   ./setup.sh               full setup
#   ./setup.sh --skip-tests  same, without running `php artisan test`
set -euo pipefail
cd "$(dirname "$0")"
SKIP_TESTS=0; [ "${1:-}" = "--skip-tests" ] && SKIP_TESTS=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
say "Checking prerequisites"
command -v php >/dev/null      || die "PHP 8.3+ is required"
command -v composer >/dev/null || die "Composer is required (https://getcomposer.org)"
php -r 'exit(version_compare(PHP_VERSION, "8.3.0", ">=") ? 0 : 1);' || die "PHP 8.3+ is required, found $(php -r 'echo PHP_VERSION;')"
missing=""
# for ext in pdo_pgsql pdo_sqlite intl mbstring curl zip xml openssl; do php -m | grep -qix "$ext" || missing="$missing $ext"; done
# [ -z "$missing" ] || die "Missing PHP extensions:$missing  (Ubuntu: sudo apt install php-pgsql php-sqlite3 php-intl php-mbstring php-curl php-zip php-xml)"
echo "PHP $(php -r 'echo PHP_VERSION;') and all extensions present"

# ---------------------------------------------------------------- skeleton + dependencies
FRESH=0
if [ ! -f artisan ]; then
  FRESH=1
  say "Creating the Laravel skeleton"
  rm -rf _skeleton
  composer create-project laravel/laravel _skeleton "^13.0" --no-interaction --prefer-dist --no-scripts
  cp -an _skeleton/. .          # -n: never overwrite our own README.md / setup.sh / overlay/
  rm -rf _skeleton
fi

say "Installing Filament, php-amqplib and php-jwt"
# Filament 5 first; if your Laravel version is not supported by it yet, fall back to Filament 4 (our code is written for that API too).
composer require "filament/filament:^5.0" php-amqplib/php-amqplib firebase/php-jwt --no-interaction \
  || composer require "filament/filament:^4.0" php-amqplib/php-amqplib firebase/php-jwt --no-interaction \
  || die "Could not install Filament. Check the Composer output above (usually a Laravel/PHP version constraint)."

say "Adding the store code"
cp -a overlay/. .
# The skeleton's example tests/factory assume a password-based users table and a web page at "/": not ours.
rm -f tests/Feature/ExampleTest.php tests/Unit/ExampleTest.php database/factories/UserFactory.php
if [ "$FRESH" = "1" ] || [ ! -f .env ]; then cp .env.example .env; fi
php artisan key:generate --force
composer dump-autoload --no-interaction
php artisan filament:assets
php artisan storage:link || true

# ---------------------------------------------------------------- database
say "Checking the database (docker compose up -d must be running)"
# php -r '
# $env = parse_ini_file(".env", false, INI_SCANNER_RAW);
# try { new PDO("pgsql:host={$env["DB_HOST"]};port={$env["DB_PORT"]};dbname={$env["DB_DATABASE"]}", $env["DB_USERNAME"], $env["DB_PASSWORD"]); echo "Postgres reachable\n"; }
# catch (Throwable $e) { fwrite(STDERR, "Cannot reach Postgres: ".$e->getMessage()."\nStart it with: docker compose up -d store-db\n"); exit(1); }
# ' || die "Database not reachable"

php -r '
require __DIR__ . "/vendor/autoload.php";
$dotenv = Dotenv\Dotenv::createImmutable(__DIR__);
$dotenv->safeLoad();

try {
    $host = $_ENV["DB_HOST"] ?? "127.0.0.1";
    $port = $_ENV["DB_PORT"] ?? "5432";
    $db   = $_ENV["DB_DATABASE"] ?? "laravel";
    $user = $_ENV["DB_USERNAME"] ?? "root";
    $pass = $_ENV["DB_PASSWORD"] ?? "";

    new PDO("pgsql:host={$host};port={$port};dbname={$db}", $user, $pass);
    echo "Postgres reachable\n";
} catch (Throwable $e) {
    fwrite(STDERR, "Cannot reach Postgres: ".$e->getMessage()."\nStart it with: docker compose up -d store-db\n");
    exit(1);
}
' || die "Database not reachable"

php artisan migrate --force
php artisan store:seed-demo

# ---------------------------------------------------------------- tests (in-memory SQLite: they never touch your database)
if [ "$SKIP_TESTS" = "0" ]; then
  say "Running the test suite"
  php artisan test || echo "WARNING: some tests failed. The app is installed, but read the failures above before relying on it."
fi

say "API routes"
php artisan route:list --path=api/v1 --except-vendor || true

cat <<'MSG'

Done. Run these in separate terminals (from this directory):
  php artisan serve --port=8000        # API (http://localhost:8000/api/v1) and back office (/admin, /vendor)
  php artisan events:consume           # listens to wallet events: marks orders paid
  php artisan outbox:relay             # publishes store.opened / store.closed / order.paid
  php artisan schedule:work            # expires unpaid orders, pays out delivered orders

Then check it:  ./verify.sh
Sign in at http://localhost:8000/admin as admin1 / password (catalog admin),
finance1 or finance2 / password (wallet corrections), or http://localhost:8000/vendor as bob / password.
MSG
