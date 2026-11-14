export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown, raw?: BodyInit, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: raw ? headers : body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401) {
    // Token cookie missing/expired → the server's sign-in page takes over.
    window.location.reload();
    throw new ApiError(401, 'unauthorized');
  }
  const type = res.headers.get('content-type') || '';
  if (!res.ok) {
    const msg = type.includes('json') ? (await res.json()).error : await res.text();
    throw new ApiError(res.status, msg || res.statusText);
  }
  return (type.includes('json') ? res.json() : res.blob()) as Promise<T>;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T,>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T,>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T,>(path: string) => request<T>('DELETE', path),
  upload: <T,>(path: string, data: Blob, contentType: string) => request<T>('POST', path, undefined, data, { 'content-type': contentType }),
};
