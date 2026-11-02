# web (Next.js)

    src/core    Pure TypeScript: API clients, socket, money helpers, config. No React DOM.   -> reusable in React Native
    src/hooks   React hooks (useChat, useWallet). React but no DOM.                          -> reusable in React Native
    src/ui      DOM components (div, input, CSS).                                            -> rewritten per platform
    src/core/auth.ts  Browser OIDC (PKCE). The one file that is web-specific below the UI.

Run: `cp .env.example .env.local && npm install && npm run dev`
