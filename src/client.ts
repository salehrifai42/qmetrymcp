// ── QTM4J HTTP client ──────────────────────────────────────────────────────────
//
// A deep module with no import-time side effects: it reads no environment, never
// touches stdio, and never calls process.exit. The network is reached through an
// injectable `Transport` port so the same retry / error-mapping / auth logic can be
// exercised by an in-memory adapter in tests and by global `fetch` in production.
//
// Two adapters justify the seam: real `fetch` in prod, a scripted fake in tests.

/** Error thrown for any non-2xx QTM4J response. Carries the parsed body. */
export class QtmApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: unknown
  ) {
    super(`HTTP ${status} ${statusText}`);
    this.name = "QtmApiError";
  }
}

/**
 * The transport seam. Satisfied by global `fetch` in production and by any
 * function returning a `Response` in tests. The client only relies on
 * `status`, `statusText`, `ok`, `headers.get()`, and `text()`.
 */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export interface QtmClientOptions {
  apiKey: string;
  baseUrl: string;
  /** Network adapter. Defaults to global `fetch`. Inject a fake in tests. */
  transport?: Transport;
  /** Delay used by the 429 back-off. Defaults to real `setTimeout`; inject a no-op in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Max attempts before a 429 is surfaced as an error. Default 3. */
  maxAttempts?: number;
}

export interface QtmClient {
  /** Perform a request against `baseUrl + path`, returning parsed JSON (or null/text). */
  fetch(path: string, options?: RequestInit): Promise<unknown>;
}

const REGION_BASE_URLS: Record<string, string> = {
  US: "https://qtmcloud.qmetry.com/rest/api/latest",
  AU: "https://syd-qtmcloud.qmetry.com/rest/api/latest",
};

/** Resolve a region code (US/AU, case-insensitive) to its API base URL, defaulting to US. */
export function resolveBaseUrl(region: string | undefined): string {
  const key = (region ?? "US").toUpperCase();
  return REGION_BASE_URLS[key] ?? REGION_BASE_URLS.US;
}

/** Build a QTM4J client bound to a base URL and API key, with an injectable transport. */
export function createQtmClient(opts: QtmClientOptions): QtmClient {
  const transport: Transport = opts.transport ?? ((url, init) => fetch(url, init));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  // Sanitize the key once, where it's added. Keys sourced from env / secret
  // managers / copy-paste frequently arrive with a trailing newline or surrounding
  // whitespace, which the API rejects with a confusing 401 if sent verbatim.
  const apiKey = opts.apiKey.trim();

  async function call(path: string, options: RequestInit = {}, attempt = 1): Promise<unknown> {
    const url = `${opts.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers as Record<string, string> | undefined),
      apiKey,
    };

    const response = await transport(url, { ...options, headers });

    // Exponential back-off for rate limiting.
    if (response.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "1", 10);
      const delay = Math.max(retryAfter * 1000, 1000) * attempt;
      await sleep(delay);
      return call(path, options, attempt + 1);
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      throw new QtmApiError(response.status, response.statusText, body);
    }

    return body;
  }

  return { fetch: call };
}
