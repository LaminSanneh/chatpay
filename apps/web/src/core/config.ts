export const config = {
  issuer: process.env.NEXT_PUBLIC_OIDC_ISSUER ?? 'http://localhost:8080/realms/chatpay',
  clientId: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? 'chatpay-web',
  chatUrl: process.env.NEXT_PUBLIC_CHAT_URL ?? 'http://localhost:4000',
  storeApiUrl: process.env.NEXT_PUBLIC_STORE_API_URL ?? 'http://localhost:8000/api/v1',
  storeUrl: process.env.NEXT_PUBLIC_STORE_URL ?? 'http://localhost:3001',
  walletUrl: process.env.NEXT_PUBLIC_WALLET_URL ?? 'http://localhost:8081',
};
