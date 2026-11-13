import { supabase } from '@/lib/supabase/client';
import { env, API_V1 } from '@/lib/env';
import { ApiError, NetworkError, type BackendErrorBody } from './errors';

/**
 * The one fetch wrapper every lib/api/*.ts module goes through — no
 * component ever calls fetch()/axios directly (Phase 13, item 2).
 *
 * Auth: the current Supabase access token is attached automatically.
 * 401 handling (item 5): refresh the session once and retry the SAME
 * request once; if that still fails (or there was no session to refresh),
 * redirect to /login. Never more than one refresh+retry — this can't
 * loop.
 */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Skip attaching a token entirely — for the rare endpoint that's
   * reachable unauthenticated. Nothing in this app currently needs this
   * for a real data call, but health checks during dev do. */
  skipAuth?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = env.apiUrl.replace(/\/api\/v1\/?$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${base}${API_V1}${cleanPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function refreshAccessToken(): Promise<string | null> {
  const { data, error } = await supabase.auth.refreshSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

async function parseErrorBody(response: Response): Promise<BackendErrorBody['error']> {
  try {
    const body = (await response.json()) as Partial<BackendErrorBody>;
    if (body?.error?.code) return body.error;
  } catch {
    // Response wasn't JSON (a raw 502 from a proxy, etc.) — fall through
    // to a generic error rather than throwing while parsing an error.
  }
  return { code: `HTTP_${response.status}`, message: response.statusText || 'Request failed.' };
}

let redirectingToLogin = false;

function redirectToLogin() {
  if (typeof window === 'undefined' || redirectingToLogin) return;

  const currentPath = window.location.pathname;
  // Never redirect if already on login or register page
  if (
    currentPath === '/login' ||
    currentPath.startsWith('/login/') ||
    currentPath === '/register' ||
    currentPath.startsWith('/register/')
  ) {
    return;
  }

  redirectingToLogin = true;

  // Determine clean, non-nested return destination
  let next = '';
  const searchParams = new URLSearchParams(window.location.search);
  const existingRedirect = searchParams.get('redirect');

  if (existingRedirect && !existingRedirect.startsWith('/login') && !existingRedirect.startsWith('/register')) {
    next = existingRedirect;
  } else if (!currentPath.startsWith('/login') && !currentPath.startsWith('/register')) {
    next = currentPath + (window.location.search || '');
  }

  // Prevent nested or repeatedly encoded redirect parameters
  if (next && next !== '/' && !next.startsWith('/login') && !next.startsWith('/register')) {
    window.location.href = `/login?redirect=${encodeURIComponent(next)}`;
  } else {
    window.location.href = '/login';
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, skipAuth = false } = options;

  const doFetch = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token && !skipAuth) headers.Authorization = `Bearer ${token}`;

    // Built outside the try below on purpose: a malformed env.apiUrl (e.g.
    // empty, so buildUrl's `new URL()` itself throws) should never be
    // silently swallowed into the same generic NetworkError a real
    // connection failure produces — log which it actually was.
    const url = buildUrl(path, query);

    try {
      return await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`[api] fetch failed for ${method} ${url}:`, err);
      }
      throw new NetworkError();
    }
  };

  const token = skipAuth ? null : await getAccessToken();
  let response = await doFetch(token);

  if (response.status === 401 && !skipAuth && token !== null) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      response = await doFetch(refreshed);
    }
  }

  if (response.status === 401 && !skipAuth) {
    redirectToLogin();
  }

  if (!response.ok) {
    const err = await parseErrorBody(response);
    throw new ApiError(response.status, err.code, err.message, err.request_id ?? null, err.retry_after_seconds ?? null);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    apiRequest<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    apiRequest<T>(path, { method: 'POST', body, query }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PUT', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};
