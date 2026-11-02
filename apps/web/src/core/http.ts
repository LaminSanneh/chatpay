export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type TokenProvider = () => Promise<string>;

export async function request<T>(url: string, getToken: TokenProvider, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let body: { code?: string; message?: string } = {};
    try { body = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.message ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
