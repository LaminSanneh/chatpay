package com.chatpay.wallet.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * The shared event fixtures (contracts/events at the repository root). Maven runs tests with the module directory as the working
 * directory, so the fixtures are two levels up.
 */
public final class Contracts {

    private static final Path DIR = Path.of("..", "..", "contracts", "events");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private Contracts() {}

    /** The fixture contracts/events/&lt;name&gt;.json, for example "transfer.completed.p2p". */
    public static JsonNode load(String name) {
        Path file = DIR.resolve(name + ".json");
        try {
            return MAPPER.readTree(Files.readString(file));
        } catch (IOException e) {
            throw new IllegalStateException("Event fixture not readable: " + file.toAbsolutePath(), e);
        }
    }

    /**
     * Differences in SHAPE between a fixture and a real payload: the same field names and the same JSON type for each field.
     * Values are ignored. A null on either side is accepted (an optional field that happens to be empty).
     * An empty list means the shapes match.
     */
    public static List<String> shapeDifferences(JsonNode expected, JsonNode actual) {
        List<String> differences = new ArrayList<>();
        compare(expected, actual, "", differences);
        return differences;
    }

    private static void compare(JsonNode expected, JsonNode actual, String path, List<String> out) {
        if (expected.isNull() || actual.isNull()) {
            return;
        }
        if (expected.isObject() && actual.isObject()) {
            String prefix = path.isEmpty() ? "" : path + ".";
            for (Iterator<Map.Entry<String, JsonNode>> it = expected.fields(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> field = it.next();
                if (!actual.has(field.getKey())) {
                    out.add(prefix + field.getKey() + ": missing from the message");
                } else {
                    compare(field.getValue(), actual.get(field.getKey()), prefix + field.getKey(), out);
                }
            }
            for (Iterator<String> names = actual.fieldNames(); names.hasNext(); ) {
                String name = names.next();
                if (!expected.has(name)) {
                    out.add(prefix + name + ": not in the fixture (add it to contracts/events)");
                }
            }
        } else if (expected.isArray() && actual.isArray()) {
            if (expected.size() > 0 && actual.size() > 0) {
                compare(expected.get(0), actual.get(0), path + "[0]", out);
            }
        } else if (expected.getNodeType() != actual.getNodeType()) {
            out.add(path + ": the fixture has " + expected.getNodeType() + ", the message has " + actual.getNodeType());
        }
    }
}
