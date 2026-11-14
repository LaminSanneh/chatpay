package com.chatpay.wallet.shared;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Takes X-Correlation-Id from the request (or makes one), puts it in the logging context for everything this request does (including the
 * events it stores), and returns it on the response. It runs before Spring Security, so even a 401 carries the id.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String id = Correlation.sanitize(request.getHeader(Correlation.HEADER));
        if (id == null) {
            id = Correlation.generate();
        }
        MDC.put(Correlation.MDC_KEY, id);
        response.setHeader(Correlation.HEADER, id);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(Correlation.MDC_KEY);          // a pooled thread must not carry this request's id into the next one
        }
    }
}
