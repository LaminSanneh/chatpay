#!/usr/bin/env bash
# Builds the store backend: fetches a fresh Laravel skeleton, adds our code on top (overlay/), installs
# Filament + the AMQP and JWT libraries, migrates, seeds and runs the test suite. Safe to re-run.
#   ./setup.sh                      full setup
#   ./setup.sh --skip-tests         same, without running `php artisan test`
#   PHP_BIN=/path/to/php ./setup.sh use a specific PHP (it is put first on PATH so composer and artisan use it too)
set -euo pipefail
cd "$(dirname "$0")"
SKIP_TESTS=0; [ "${1:-}" = "--skip-tests" ] && SKIP_TESTS=1

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

if [ -n "${PHP_BIN:-}" ]; then
  [ -x "$PHP_BIN" ] || die "PHP_BIN is not executable: $PHP_BIN"
  export PATH="$(dirname "$PHP_BIN"):$PATH"
fi

# ---------------------------------------------------------------- preflight
say "Checking prerequisites"
command -v php >/dev/null      || die "PHP 8.3+ is required"
command -v composer >/dev/null || die "Composer is required (https://getcomposer.org)"
PHP_FOUND=$(php -r 'echo PHP_VERSION;')
php -r 'exit(version_compare(PHP_VERSION, "8.3.0", ">=") ? 0 : 1);' || die "PHP 8.3+ is required, found $PHP_FOUND at $(command -v php)"

# Ask PHP itself which extensions are loaded.
# (Do NOT do `php -m | grep -q ...` under `set -o pipefail`: grep exits at its first match, php then dies of SIGPIPE, the
#  pipeline reports failure, and a perfectly loaded extension is reported as "missing", differently on every run.)
missing=$(php -r 'echo implode(" ", array_filter(array_slice($argv, 1), fn ($e) => ! extension_loaded($e)));' -- \
  pdo_pgsql pdo_sqlite intl mbstring curl zip xml openssl)
if [ -n "$missing" ]; then
  echo "PHP $PHP_FOUND at $(command -v php) is missing:$missing" >&2
  case "$(uname -s)" in
    Darwin) echo "macOS: 'brew install php' includes all of these. With a version manager (phpenv, asdf, Herd, shivammathur/php) use a build that has them, or point PHP_BIN at one." >&2 ;;
    *)      echo "Ubuntu/Debian: sudo apt install php-pgsql php-sqlite3 php-intl php-mbstring php-curl php-zip php-xml" >&2 ;;
  esac
  die "Install the missing PHP extensions, then run ./setup.sh again"
fi
echo "PHP $PHP_FOUND at $(command -v php): all required extensions are loaded"

# ---------------------------------------------------------------- skeleton + dependencies
if [ ! -f artisan ]; then
  say "Creating the Laravel skeleton"
  rm -rf _skeleton                 # left over from an interrupted earlier run (create-project refuses an existing folder)
  # --no-scripts: the skeleton's own post-install steps would create a default SQLite .env and migrate it. We bring our own .env.
  composer create-project laravel/laravel _skeleton "^13.0" --no-interaction --prefer-dist --no-scripts
  cp -an _skeleton/. .             # -n: never overwrite our own README.md / setup.sh / overlay/
  rm -rf _skeleton
fi
[ -f .env ] || cp .env.example .env   # only so that composer's own artisan calls can boot; replaced below by our .env

say "Installing Filament, php-amqplib and php-jwt"
# Filament 5 first; if your Laravel version is not supported by it yet, fall back to Filament 4 (our code is written for that API too).
composer require "filament/filament:^5.0" php-amqplib/php-amqplib firebase/php-jwt --no-interaction \
  || composer require "filament/filament:^4.0" php-amqplib/php-amqplib firebase/php-jwt --no-interaction \
  || die "Could not install Filament. Check the Composer output above (usually a Laravel/PHP version constraint)."

say "Adding the store code"
cp -a overlay/. .                  # overwrites the skeleton's files, including .env.example, with ours
# The skeleton's example tests/factory assume a password-based users table and a web page at "/": not ours.
rm -f tests/Feature/ExampleTest.php tests/Unit/ExampleTest.php database/factories/UserFactory.php

# .env is what Laravel actually reads. If it still has the skeleton's SQLite defaults, replace it with ours (keeping a backup);
# if you already customised it (no longer sqlite), leave it alone.
if [ ! -f .env ]; then
  cp .env.example .env
elif grep -q '^DB_CONNECTION=sqlite' .env; then
  echo ".env still has the skeleton's SQLite defaults: replacing it with ours (old one saved as .env.skeleton-backup)"
  mv .env .env.skeleton-backup
  cp .env.example .env
fi
grep -q '^APP_KEY=.\+' .env || php artisan key:generate --force    # keep the key on re-runs: it signs sessions

composer dump-autoload --no-interaction
php artisan filament:assets
php artisan storage:link || true

# ---------------------------------------------------------------- database
say "Checking the database (docker compose up -d must be running)"
php -r '
require getcwd()."/vendor/autoload.php";
Dotenv\Dotenv::createImmutable(getcwd())->safeLoad();      // reads .env the way Laravel does (it is not an INI file)
$host = $_SERVER["DB_HOST"] ?? "127.0.0.1"; $port = $_SERVER["DB_PORT"] ?? "5435"; $db = $_SERVER["DB_DATABASE"] ?? "laravel";
try { new PDO("pgsql:host={$host};port={$port};dbname={$db}", $_SERVER["DB_USERNAME"] ?? "root", $_SERVER["DB_PASSWORD"] ?? ""); echo "Postgres reachable at {$host}:{$port}/{$db}\n"; }
catch (Throwable $e) { fwrite(STDERR, "Cannot reach Postgres: ".$e->getMessage()."\nStart it with: docker compose up -d store-db\n"); exit(1); }
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

Done.
  ./dev.sh        starts everything in ONE terminal: web (:8000), events:consume, outbox:relay, schedule:work. Ctrl-C stops all.
  ./verify.sh     smoke test of the running stack
Sign in at http://localhost:8000/admin as admin1 / password (catalog admin),
finance1 or finance2 / password (wallet corrections), or http://localhost:8000/vendor as bob / password.
MSG
