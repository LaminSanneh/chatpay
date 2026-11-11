package com.chatpay.wallet;

import com.chatpay.wallet.settlement.SettlementCompleted;
import com.chatpay.wallet.support.Contracts;
import com.chatpay.wallet.transfer.TransferCompleted;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The events this service publishes, against the shared fixtures in contracts/events. No Spring, no Docker: the real event records are
 * read from, and written back to, JSON the way the AMQP converter does it. If a field is added, removed, renamed or retyped on a record,
 * this test fails until the fixture (and so every consumer's test) is updated in the same commit.
 */
class EventContractTest {

    private static final ObjectMapper MAPPER = JsonMapper.builder()
            .addModule(new JavaTimeModule())
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"transfer.completed.p2p", "transfer.completed.order-payment"})
    void transferCompletedIsExactlyItsFixture(String fixture) throws Exception {
        JsonNode expected = Contracts.load(fixture);

        TransferCompleted event = MAPPER.treeToValue(expected, TransferCompleted.class);

        assertThat(MAPPER.valueToTree(event).toString()).isEqualTo(expected.toString());
    }

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"settlement.completed.release", "settlement.completed.refund"})
    void settlementCompletedIsExactlyItsFixture(String fixture) throws Exception {
        JsonNode expected = Contracts.load(fixture);

        SettlementCompleted event = MAPPER.treeToValue(expected, SettlementCompleted.class);

        assertThat(MAPPER.valueToTree(event).toString()).isEqualTo(expected.toString());
    }

    @Test
    void aFixtureWithAFieldTheRecordDoesNotHaveIsRejected() {
        ObjectNode withExtra = Contracts.load("transfer.completed.p2p").deepCopy();
        withExtra.put("surprise", 1);

        assertThatThrownBy(() -> MAPPER.treeToValue(withExtra, TransferCompleted.class)).hasMessageContaining("surprise");
    }

    @Test
    void aFixtureMissingAFieldTheRecordHasIsDetected() throws Exception {
        ObjectNode withoutNote = Contracts.load("transfer.completed.p2p").deepCopy();
        withoutNote.remove("note");

        TransferCompleted event = MAPPER.treeToValue(withoutNote, TransferCompleted.class);

        assertThat(MAPPER.valueToTree(event).toString()).as("the record still writes a note, so the fixture was incomplete").isNotEqualTo(withoutNote.toString());
    }

    @Test
    void theShapeComparisonUsedByTheBrokerTestNoticesMissingExtraAndRetypedFields() throws Exception {
        JsonNode fixture = new ObjectMapper().readTree("{\"a\":1,\"b\":\"x\",\"c\":{\"d\":1.5},\"e\":[{\"f\":1}],\"n\":null}");

        assertThat(Contracts.shapeDifferences(fixture,
                new ObjectMapper().readTree("{\"a\":2,\"b\":\"y\",\"c\":{\"d\":2.5},\"e\":[{\"f\":9}],\"n\":\"set\"}"))).isEmpty();
        assertThat(Contracts.shapeDifferences(fixture,
                new ObjectMapper().readTree("{\"a\":1,\"c\":{\"d\":1.5},\"e\":[{\"f\":1}],\"n\":null}"))).containsExactly("b: missing from the message");
        assertThat(Contracts.shapeDifferences(new ObjectMapper().readTree("{\"a\":1}"),
                new ObjectMapper().readTree("{\"a\":1,\"z\":true}"))).containsExactly("z: not in the fixture (add it to contracts/events)");
        assertThat(Contracts.shapeDifferences(new ObjectMapper().readTree("{\"a\":1}"),
                new ObjectMapper().readTree("{\"a\":\"1\"}"))).containsExactly("a: the fixture has NUMBER, the message has STRING");
        assertThat(Contracts.shapeDifferences(new ObjectMapper().readTree("{\"e\":[{\"f\":1}]}"),
                new ObjectMapper().readTree("{\"e\":[{\"f\":\"x\"}]}"))).containsExactly("e[0].f: the fixture has NUMBER, the message has STRING");
    }
}
