<?php

namespace Tests\Support;

/** Loads the shared event fixtures (contracts/events at the repo root) and compares payloads with them by SHAPE. */
final class Contract
{
    /** @return array<string, mixed> The fixture `contracts/events/<name>.json`. */
    public static function load(string $name): array
    {
        $path = base_path('../../contracts/events/'.$name.'.json');
        if (! is_file($path)) {
            throw new \RuntimeException("Event fixture not found: {$path}");
        }

        return json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
    }

    /**
     * Differences in SHAPE between a fixture and a real payload: the same keys, and the same type for each key. Values are ignored.
     * A null on either side is accepted (an optional field that happens to be empty).
     *
     * @return list<string> empty when the shapes match
     */
    public static function shapeDifferences(array $expected, array $actual, string $path = ''): array
    {
        if (array_is_list($expected) && array_is_list($actual)) {
            return ($expected && $actual) ? self::valueDifferences($expected[0], $actual[0], $path.'[0]') : [];
        }

        $prefix = $path === '' ? '' : $path.'.';
        $differences = [];
        foreach ($expected as $key => $value) {
            if (! array_key_exists($key, $actual)) {
                $differences[] = "{$prefix}{$key}: missing from the payload";
                continue;
            }
            array_push($differences, ...self::valueDifferences($value, $actual[$key], $prefix.$key));
        }
        foreach (array_keys($actual) as $key) {
            if (! array_key_exists($key, $expected)) {
                $differences[] = "{$prefix}{$key}: not in the fixture (add it to contracts/events)";
            }
        }

        return $differences;
    }

    private static function valueDifferences(mixed $expected, mixed $actual, string $path): array
    {
        if ($expected === null || $actual === null) {
            return [];
        }
        if (is_array($expected) && is_array($actual)) {
            return self::shapeDifferences($expected, $actual, $path);
        }

        return gettype($expected) === gettype($actual) ? [] : ["{$path}: the fixture has ".gettype($expected).', the payload has '.gettype($actual)];
    }
}
