package com.chatpay.wallet.support;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.Map;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

/**
 * Lets the tests sign in WITHOUT a running Keycloak, while still exercising the real security chain.
 *
 * The app normally verifies Keycloak's RS256 tokens through its JWKS. Here the JwtDecoder is replaced by one that accepts tokens
 * signed with a test-only secret, and `token(...)` mints them with the same claims Keycloak puts in an access token
 * (sub, iss, realm_access.roles). Everything after the decoder, notably SecurityConfig's role mapping and the route rules,
 * is the production code.
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestJwtConfig {

    public static final String ISSUER = "http://localhost:8080/realms/chatpay";

    /** HS256 needs at least 32 bytes. Test-only: never reuse this anywhere real. */
    private static final SecretKey KEY = new SecretKeySpec(
            "wallet-integration-tests-only-secret-0123456789".getBytes(StandardCharsets.UTF_8), "HmacSHA256");

    @Bean
    @Primary
    JwtDecoder testJwtDecoder() {
        return NimbusJwtDecoder.withSecretKey(KEY).macAlgorithm(MacAlgorithm.HS256).build();
    }

    /** A signed access token for `subject` carrying the given Keycloak realm roles (for example "wallet-admin"). */
    public static String token(String subject, String... realmRoles) {
        try {
            Instant now = Instant.now();
            JWTClaimsSet claims = new JWTClaimsSet.Builder()
                    .subject(subject)
                    .issuer(ISSUER)
                    .issueTime(Date.from(now))
                    .expirationTime(Date.from(now.plusSeconds(600)))
                    .claim("preferred_username", subject)
                    .claim("realm_access", Map.of("roles", List.of(realmRoles)))
                    .build();
            SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
            jwt.sign(new MACSigner(KEY.getEncoded()));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException("could not sign a test token", e);
        }
    }
}
