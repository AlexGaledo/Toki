import { apiRequest, IntegrationError, type ApiResponse, type Fetch, type RequestOpts } from './http.js';

export interface ClientDeps {
  fetch: Fetch;
  token(refresh?: boolean): Promise<string>;
  appToken?(): Promise<string | null>;
}

export interface PollResult<T> {
  items: T[];
  cursor: string | null;
  etag?: string | null;
  notModified: boolean;
  resync: boolean;
  pollIntervalSec?: number;
}

export abstract class ApiClient {
  constructor(protected deps: ClientDeps) {}

  protected authHeader(token: string): string {
    return 'Bearer ' + token;
  }

  protected async call<T>(url: string, opts: RequestOpts = {}): Promise<ApiResponse<T>> {
    const token = await this.deps.token(false);
    try {
      return await apiRequest<T>(this.deps.fetch, url, { ...opts, headers: { ...opts.headers, authorization: this.authHeader(token) } });
    } catch (e) {
      if (!(e instanceof IntegrationError) || !e.auth) throw e;
      let fresh: string;
      try {
        fresh = await this.deps.token(true);
      } catch {
        throw e;
      }
      if (fresh === token) throw e;
      return apiRequest<T>(this.deps.fetch, url, { ...opts, headers: { ...opts.headers, authorization: this.authHeader(fresh) } });
    }
  }
}

export function clip(s: string, max = 20_000): string {
  return s.length > max ? s.slice(0, max) + '\n…[truncated, ' + (s.length - max) + ' more characters]' : s;
}
