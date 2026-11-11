package com.chatpay.wallet.shared;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.springframework.modulith.events.IncompleteEventPublications;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;

/**
 * The timer that republishes stored events. Whether a real broker outage ends with the event delivered is proven end to end by
 * scripts/e2e-resilience.sh (scenario broker-outage); this checks the timer's own behaviour.
 */
class OutboxSweeperTest {

    private final IncompleteEventPublications incomplete = mock(IncompleteEventPublications.class);

    @Test
    void sweepingResubmitsEventsThatHaveBeenWaitingLongerThanTheConfiguredAge() {
        new OutboxSweeper(incomplete, 45).sweep();

        verify(incomplete).resubmitIncompletePublicationsOlderThan(Duration.ofSeconds(45));
        verifyNoMoreInteractions(incomplete);
    }

    @Test
    void everyTickTriesAgain() {
        OutboxSweeper sweeper = new OutboxSweeper(incomplete, 30);

        sweeper.sweep();
        sweeper.sweep();
        sweeper.sweep();

        verify(incomplete, times(3)).resubmitIncompletePublicationsOlderThan(Duration.ofSeconds(30));
    }

    @Test
    void aFailureIsLoggedNotThrownSoTheTimerKeepsRunning() {
        doThrow(new IllegalStateException("broker down")).when(incomplete).resubmitIncompletePublicationsOlderThan(any(Duration.class));

        assertThatCode(() -> new OutboxSweeper(incomplete, 30).sweep()).doesNotThrowAnyException();
    }
}
