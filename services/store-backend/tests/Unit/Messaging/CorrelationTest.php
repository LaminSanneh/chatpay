<?php

namespace Tests\Unit\Messaging;

use App\Support\Correlation;
use PHPUnit\Framework\TestCase;

class CorrelationTest extends TestCase
{
    protected function setUp(): void
    {
        Correlation::listen(null);
        Correlation::set(null);
    }

    protected function tearDown(): void
    {
        Correlation::listen(null);
        Correlation::set(null);
    }

    public function test_generated_ids_are_version_4_uuids_and_different_each_time(): void
    {
        $a = Correlation::generate();
        $b = Correlation::generate();

        $this->assertMatchesRegularExpression('/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/', $a);
        $this->assertNotSame($a, $b);
    }

    public function test_ordinary_ids_are_accepted_and_anything_that_could_forge_a_log_line_is_refused(): void
    {
        foreach ([Correlation::generate(), 'req-123', 'a.b_c:d-e', str_repeat('X', 64)] as $id) {
            $this->assertSame($id, Correlation::sanitize($id));
        }
        $this->assertSame('first', Correlation::sanitize(['first', 'second']));
        foreach (['', str_repeat('X', 65), 'two words', "line\nbreak", "inject\r\nERROR fake", '<script>', 'ünï', 42, null, [], new \stdClass()] as $bad) {
            $this->assertNull(Correlation::sanitize($bad), var_export($bad, true));
        }
        $this->assertNull(Correlation::sanitize("abc\n"), 'a trailing newline must not slip past the end-of-string check');
    }

    public function test_there_is_no_id_outside_a_request_or_message_and_a_fresh_one_is_offered_instead(): void
    {
        $this->assertNull(Correlation::current());
        $this->assertSame(36, strlen(Correlation::currentOrNew()));
        $this->assertNull(Correlation::current(), 'currentOrNew does not set anything');
    }

    public function test_within_uses_the_id_and_restores_the_previous_one_even_when_it_fails(): void
    {
        Correlation::set('outer');

        $seen = Correlation::within('inner', fn () => Correlation::current());
        $this->assertSame('inner', $seen);
        $this->assertSame('outer', Correlation::current());

        try {
            Correlation::within('failing', function () {
                throw new \RuntimeException('boom');
            });
            $this->fail('expected the exception');
        } catch (\RuntimeException) {
            $this->assertSame('outer', Correlation::current());
        }
    }

    public function test_within_replaces_a_missing_or_invalid_id_and_nests(): void
    {
        $generated = Correlation::within(null, fn () => Correlation::current());
        $replaced = Correlation::within("bad id\n", fn () => Correlation::current());
        $nested = Correlation::within('a', fn () => [Correlation::current(), Correlation::within('b', fn () => Correlation::current()), Correlation::current()]);

        $this->assertSame(36, strlen($generated));
        $this->assertSame(36, strlen($replaced));
        $this->assertSame(['a', 'b', 'a'], $nested);
        $this->assertNull(Correlation::current());
    }

    public function test_the_listener_hears_every_change_so_the_log_context_follows(): void
    {
        $heard = [];
        Correlation::listen(function (?string $id) use (&$heard) {
            $heard[] = $id;
        });

        Correlation::set('r1');
        Correlation::within('m1', fn () => null);
        Correlation::set(null);

        $this->assertSame(['r1', 'm1', 'r1', null], $heard);
    }
}
