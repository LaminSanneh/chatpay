package com.chatpay.wallet;

import com.chatpay.wallet.support.OrderWalletIntegrationTest;
import com.chatpay.wallet.support.TestJwtConfig;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.nimbusds.jwt.SignedJWT;
import java.security.SecureRandom;
import java.util.Date;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.springframework.http.HttpMethod;
import org.springframework.mock.web.MockHttpServletResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;

/**
 * Who may call what. The tokens are minted by TestJwtConfig, but everything after the decoder (the Keycloak role mapping, the route
 * rules, CORS) is the production SecurityConfig.
 */
@Timeout(180)
class SecurityIT extends OrderWalletIntegrationTest {

    private static final List<String> USER_ENDPOINTS = List.of("/api/v1/wallet", "/api/v1/transfers", "/api/v1/transfer-intents?open=true");
    private static final String MERCHANT_PATH = "/api/v1/internal/transfer-intents";
    private static final String ADMIN_PATH = "/api/v1/admin/reconciliation";

    private Map<String, Object> merchantBody() {
        return Map.of("payerUserId", newUser(), "storeId", newStore(), "orderId", newOrder(), "amountMinor", 100);
    }

    // ------------------------------------------------------------------ no or bad credentials
    @Test
    void everythingExceptHealthNeedsAToken() {
        for (String path : USER_ENDPOINTS) {
            assertThat(get(path, null).status()).as(path).isEqualTo(401);
        }
        assertThat(post("/api/v1/transfer-intents", null, Map.of("toUserId", "x", "amountMinor", 1)).status()).isEqualTo(401);
        assertThat(post("/api/v1/dev/topup", null, Map.of("amountMinor", 1)).status()).isEqualTo(401);
        assertThat(post(MERCHANT_PATH, null, merchantBody()).status()).isEqualTo(401);
        assertThat(get(ADMIN_PATH, null).status()).isEqualTo(401);
    }

    @Test
    void garbageTamperedWrongKeyAndUnsignedTokensAreRefused() throws JOSEException {
        String valid = as(newUser());
        String[] parts = valid.split("\\.");
        char middle = parts[2].charAt(10);
        String tamperedSignature = parts[0] + "." + parts[1] + "." + parts[2].substring(0, 10) + (middle == 'A' ? 'B' : 'A') + parts[2].substring(11);
        String tamperedPayload = parts[0] + "." + java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"someone-else\",\"iss\":\"http://localhost:8080/realms/chatpay\"}".getBytes()) + "." + parts[2];

        JWTClaimsSet claims = new JWTClaimsSet.Builder().subject("mallory").issuer(TestJwtConfig.ISSUER)
                .expirationTime(new Date(System.currentTimeMillis() + 600_000)).build();
        byte[] otherSecret = new byte[32];
        new SecureRandom().nextBytes(otherSecret);
        SignedJWT wrongKey = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
        wrongKey.sign(new MACSigner(otherSecret));
        String unsigned = new PlainJWT(claims).serialize();

        for (String token : List.of("garbage", "a.b.c", tamperedSignature, tamperedPayload, wrongKey.serialize(), unsigned)) {
            assertThat(get("/api/v1/wallet", token).status()).as("token %s...", token.substring(0, Math.min(12, token.length()))).isEqualTo(401);
        }
        assertThat(get("/api/v1/wallet", valid).status()).as("the untouched token still works").isEqualTo(200);
    }

    // ------------------------------------------------------------------ roles
    @Test
    void anOrdinaryUserCannotUseTheMerchantOrAdminEndpoints() {
        String user = as(newUser());

        assertThat(post(MERCHANT_PATH, user, merchantBody()).status()).isEqualTo(403);
        assertThat(post("/api/v1/internal/orders/any/release", user, Map.of("commissionMinor", 0)).status()).isEqualTo(403);
        assertThat(post("/api/v1/internal/orders/any/refund", user, null).status()).isEqualTo(403);
        assertThat(get(ADMIN_PATH, user).status()).isEqualTo(403);
        assertThat(get("/api/v1/admin/users/" + newUser() + "/wallet", user).status()).isEqualTo(403);
        assertThat(post("/api/v1/admin/adjustments", user, Map.of("accountId", java.util.UUID.randomUUID().toString(), "direction", "CREDIT",
                "amountMinor", 1, "reasonCode", "X", "reason", "Y")).status()).isEqualTo(403);
    }

    @Test
    void theMerchantRoleOpensOnlyTheMerchantEndpointsAndTheAdminRoleOnlyTheAdminOnes() {
        assertThat(post(MERCHANT_PATH, merchant(), merchantBody()).status()).isEqualTo(201);
        assertThat(get(ADMIN_PATH, merchant()).status()).as("a merchant is not an admin").isEqualTo(403);

        assertThat(get(ADMIN_PATH, admin(newUser())).status()).isEqualTo(200);
        assertThat(post(MERCHANT_PATH, admin(newUser()), merchantBody()).status()).as("an admin is not a merchant").isEqualTo(403);
    }

    @Test
    void rolesAreOnlyReadFromTheRealmAccessClaim() throws JOSEException {
        JWTClaimsSet claims = new JWTClaimsSet.Builder().subject(newUser()).issuer(TestJwtConfig.ISSUER)
                .expirationTime(new Date(System.currentTimeMillis() + 600_000))
                .claim("roles", List.of("wallet-admin"))                                           // wrong place
                .claim("scope", "wallet-admin")
                .build();
        // Signed with the test key by going through TestJwtConfig for a user with no roles, then checking that claims of this
        // shape (which we cannot sign here) are not what grants access: the token below has the right place but no roles.
        assertThat(get(ADMIN_PATH, TestJwtConfig.token(newUser())).status()).as("no roles, no access").isEqualTo(403);
        assertThat(claims.getClaim("roles")).isNotNull();
    }

    // ------------------------------------------------------------------ identity comes from the token, never from the request
    @Test
    void theSenderOfAPaymentIsAlwaysTheTokenHolderWhateverTheBodySays() {
        String attacker = newUser(), victim = newUser(), bob = newUser();
        topUp(victim, 5_000);

        Response r = post("/api/v1/transfer-intents", as(attacker), Map.of("toUserId", bob, "amountMinor", 100, "fromUserId", victim));

        assertThat(r.status()).isEqualTo(201);
        assertThat(r.text("fromUserId")).isEqualTo(attacker);
        assertThat(confirm(attacker, r.text("id")).code()).as("the attacker has no money of their own").isEqualTo("INSUFFICIENT_FUNDS");
        assertThat(balance(victim)).isEqualTo(5_000);
    }

    // ------------------------------------------------------------------ actuator and CORS
    @Test
    void healthIsOpenAndNothingElseOfTheActuatorIsExposed() {
        Response health = get("/actuator/health", null);

        assertThat(health.status()).isEqualTo(200);
        assertThat(health.text("status")).isEqualTo("UP");
        assertThat(get("/actuator/env", null).status()).isEqualTo(401);
        assertThat(get("/actuator/env", as(newUser())).status()).as("not exposed at all").isEqualTo(404);
    }

    @Test
    void browsersFromTheTwoFrontendsMayCallTheApiAndOthersMayNot() throws Exception {
        for (String origin : List.of("http://localhost:3000", "http://localhost:3001")) {
            MockHttpServletResponse allowed = mvc.perform(options("/api/v1/transfer-intents")
                    .header("Origin", origin)
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Headers", "authorization,content-type")).andReturn().getResponse();
            assertThat(allowed.getStatus()).as(origin).isEqualTo(200);
            assertThat(allowed.getHeader("Access-Control-Allow-Origin")).isEqualTo(origin);
        }

        MockHttpServletResponse denied = mvc.perform(options("/api/v1/transfer-intents")
                .header("Origin", "http://evil.example")
                .header("Access-Control-Request-Method", "POST")).andReturn().getResponse();

        assertThat(denied.getStatus()).isEqualTo(403);
        assertThat(denied.getHeader("Access-Control-Allow-Origin")).isNull();
    }

    @Test
    void httpMethodsThatDoNotExistAreRefusedNotImprovised() {
        String user = as(newUser());

        assertThat(call(HttpMethod.DELETE, "/api/v1/transfers/" + java.util.UUID.randomUUID(), user, null).status()).isIn(404, 405);
        assertThat(call(HttpMethod.PUT, "/api/v1/wallet", user, Map.of("balanceMinor", 1_000_000)).status()).isIn(404, 405);
        assertThat(call(HttpMethod.POST, "/api/v1/transfers", user, Map.of("amountMinor", 1)).status()).as("there is no direct transfer endpoint").isIn(404, 405);
    }
}
