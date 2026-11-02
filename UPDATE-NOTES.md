# How to apply this update to your copy of the repo

Unzip over the repo root (it only touches the files listed here):

    services/store-backend/setup.sh                                  (replaces yours: includes all the fixes you found)
    services/store-backend/dev.sh                                    (new)
    services/store-backend/verify.sh                                 (replaces yours)
    services/store-backend/overlay/bootstrap/app.php                 (rate limiting: authenticate first)
    services/store-backend/overlay/app/Providers/AppServiceProvider.php   (named, per-person rate limiters)
    services/store-backend/overlay/routes/api.php                    (uses those limiters)
    services/store-backend/overlay/tests/Feature/StoreOnboardingTest.php  (+1 test)
    docs/events.md                                                   (new: event map, workers, dead-letter notes)
    CHECKLIST-additions.md                                           (paste into CHECKLIST.md)

Then, from services/store-backend:   ./setup.sh   (safe to re-run: it copies overlay/ into the app, keeps your .env and APP_KEY)
and clear the rate-limit counters left by earlier runs:   php artisan cache:clear
