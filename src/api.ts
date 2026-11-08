// API client. Identity comes from the Whop user token when the app runs
// inside Whop; for local development a dev user id can be passed once via
// ?dev_user=<whop user id> and is kept in sessionStorage. The server only
// honors the dev header outside production.

function bootParams() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || params.get('whop_user_token');
  if (token) sessionStorage.setItem('cd_token', token);
  const devUser = params.get('dev_user');
  if (devUser) sessionStorage.setItem('cd_dev_user', devUser);
  const devCompany = params.get('dev_company');
  if (devCompany) sessionStorage.setItem('cd_dev_company', devCompany);
}
bootParams();

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, body: any) {
    super(body?.message || body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error;
  }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = sessionStorage.getItem('cd_token');
  const devUser = sessionStorage.getItem('cd_dev_user');
  const devCompany = sessionStorage.getItem('cd_dev_company');
  if (token) headers['x-whop-user-token'] = token;
  else if (devUser) headers['x-whop-dev-user-id'] = devUser;
  if (devCompany) headers['x-whop-dev-company-id'] = devCompany;
  return headers;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export async function downloadJson(path: string, filename: string) {
  const res = await fetch(path, { headers: { ...authHeaders() } });
  if (!res.ok) throw new ApiError(res.status, null);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
