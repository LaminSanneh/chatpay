package com.chatpay.wallet.shared;

import com.chatpay.wallet.settlement.SettlementCompleted;
import com.chatpay.wallet.support.Contracts;
import com.chatpay.wallet.transfer.TransferCompleted;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import jakarta.servlet.FilterChain;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Correlation ids: what is accepted, how the HTTP filter treats them, and that the event headers carry them. No Spring context, no Docker. */
class CorrelationTest {

    private static final String UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    private static final ObjectMapper MAPPER = JsonMapper.builder().addModule(new JavaTimeModule()).disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS).build();

    // ------------------------------------------------------------------ the id itself
    @ParameterizedTest
    @ValueSource(strings = {"req-123", "a.b_c:d-e", "c0a8f3d2-7e41-4b9a-9d6c-5f1e2a3b4c5d"})
    void ordinaryIdsAreAccepted(String id) {
        assertThat(Correlation.sanitize(id)).isEqualTo(id);
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"", "two words", "line\nbreak", "inject\r\nERROR fake", "<script>", "abc\n"})
    void anythingThatCouldForgeALogLineIsRefused(String id) {
        assertThat(Correlation.sanitize(id)).isNull();
    }

    @Test
    void sixtyFourCharactersAreAllowedAndSixtyFiveAreNot() {
        assertThat(Correlation.sanitize("X".repeat(64))).isNotNull();
        assertThat(Correlation.sanitize("X".repeat(65))).isNull();
    }

    @Test
    void outsideARequestThereIsNoIdAndAFreshOneIsOffered() {
        assertThat(Correlation.current()).isNull();
        assertThat(Correlation.currentOrNew()).matches(UUID_PATTERN);
        assertThat(Correlation.current()).as("currentOrNew does not set anything").isNull();
    }

    // ------------------------------------------------------------------ the HTTP filter
    private record Outcome(MockHttpServletResponse response, List<String> seenInside) {}

    private Outcome run(String headerValue) throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/api/v1/wallet");
        if (headerValue != null) {
            request.addHeader(Correlation.HEADER, headerValue);
        }
        MockHttpServletResponse response = new MockHttpServletResponse();
        List<String> seen = new ArrayList<>();
        FilterChain chain = (req, res) -> seen.add(MDC.get(Correlation.MDC_KEY));
        new CorrelationIdFilter().doFilter(request, response, chain);
        return new Outcome(response, seen);
    }

    @Test
    void aValidIdFromTheClientIsUsedEchoedAndVisibleToTheHandler() throws Exception {
        Outcome o = run("from-the-client-1");

        assertThat(o.response().getHeader("X-Correlation-Id")).isEqualTo("from-the-client-1");
        assertThat(o.seenInside()).containsExactly("from-the-client-1");
        assertThat(MDC.get(Correlation.MDC_KEY)).as("cleared afterwards").isNull();
    }

    @Test
    void withoutOneAUuidIsGeneratedAndAnInvalidOneIsReplaced() throws Exception {
        for (String header : new String[] {null, "", "not valid!", "inject\nERROR"}) {
            Outcome o = run(header);

            assertThat(o.response().getHeader("X-Correlation-Id")).matches(UUID_PATTERN);
            assertThat(o.seenInside()).containsExactly(o.response().getHeader("X-Correlation-Id"));
        }
    }

    @Test
    void theIdIsClearedEvenWhenTheRequestFails() {
        FilterChain failing = (req, res) -> { throw new IllegalStateException("boom"); };

        assertThatThrownBy(() -> new CorrelationIdFilter().doFilter(new MockHttpServletRequest(), new MockHttpServletResponse(), failing))
                .isInstanceOf(IllegalStateException.class);

        assertThat(MDC.get(Correlation.MDC_KEY)).isNull();
    }

    // ------------------------------------------------------------------ the AMQP header
    @Test
    void theRealExternalizationConfigurationSendsTheEventsCorrelationIdAsAnAmqpHeader() throws Exception {
        TransferCompleted transfer = MAPPER.treeToValue(Contracts.load("transfer.completed.p2p"), TransferCompleted.class);
        SettlementCompleted settlement = MAPPER.treeToValue(Contracts.load("settlement.completed.release"), SettlementCompleted.class);
        var configuration = new EventHeadersConfig().eventExternalizationConfiguration();

        assertThat(configuration.getHeadersFor(transfer)).isEqualTo(Map.of("x-correlation-id", "c0a8f3d2-7e41-4b9a-9d6c-5f1e2a3b4c5d"));
        assertThat(configuration.getHeadersFor(settlement)).isEqualTo(Map.of("x-correlation-id", "8d1f4a62-5b3e-4c97-b0a2-6e9d8c7b1f45"));
    }

    @Test
    void anEventWithoutAnIdOrNotCorrelatedAtAllGetsNoHeader() throws Exception {
        TransferCompleted noId = new TransferCompleted(1, null, null, "P2P", "a", "b", 1, "GMD", null, null, null, null, null);

        assertThat(EventHeadersConfig.headersOf(noId)).isEmpty();
        assertThat(EventHeadersConfig.headersOf("some other event")).isEmpty();
    }
}
