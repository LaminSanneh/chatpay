# store-web (Next.js storefront)

Port 3001. Anyone can browse (server-rendered from the Laravel API); ordering needs a Keycloak login (client `store-web`,
same realm as the chat, so signing in on one signs you in on the other).

    src/app          pages: / · /products · /products/[slug] · /stores/[slug] · /cart · /orders · /sell · /callback
    src/core         http, auth (OIDC PKCE), money, store API client, wallet client (confirm payment), types
    src/cart         cart in localStorage (works anonymously; prices shown are a preview, the store prices the real order)
    src/ui           header, product card, auth provider, PayOrderDialog

Checkout: `POST /orders` (store backend prices it and creates a payment in the wallet) -> `PayOrderDialog` confirms that payment in the
wallet with your own token -> the store backend receives the wallet's event and the order becomes `paid`.
`core/`, `PayOrderDialog` are copies of the ones in `apps/web` until a shared package exists (see CHECKLIST).

Run: `cp .env.example .env.local && npm install && npm run dev`
