<?php

// Lets the framework-free unit tests (tests/Unit/Messaging) run with a plain PHPUnit and no Composer install:
//   phpunit --bootstrap tests/standalone-bootstrap.php tests/Unit/Messaging
spl_autoload_register(function (string $class): void {
    $prefix = 'App\\Messaging\\';
    if (str_starts_with($class, $prefix)) {
        $file = __DIR__.'/../app/Messaging/'.substr($class, strlen($prefix)).'.php';
        if (is_file($file)) {
            require $file;
        }
    }
});
