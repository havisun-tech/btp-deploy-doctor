import * as http from 'http';
import * as https from 'https';

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Client certificate and key (PEM) for mTLS, e.g. x509 service bindings. */
  cert?: string;
  key?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Network-level failure (DNS, refused, TLS, timeout). `code` is the Node.js error code. */
export class HttpError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export type HttpFn = (url: string, req?: HttpRequest) => Promise<HttpResponse>;

const MAX_BODY = 2 * 1024 * 1024;

/** Minimal HTTP(S) client without redirects, so a redirect to a login page is visible. */
export const httpRequest: HttpFn = (url, req = {}) =>
  new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return reject(new HttpError(`Invalid URL: ${url}`, 'ERR_INVALID_URL'));
    }
    const lib = u.protocol === 'http:' ? http : u.protocol === 'https:' ? https : undefined;
    if (!lib) return reject(new HttpError(`Unsupported protocol in ${url}`, 'ERR_INVALID_PROTOCOL'));
    const r = lib.request(
      u,
      { method: req.method ?? 'GET', headers: req.headers, cert: req.cert, key: req.key, timeout: req.timeoutMs ?? 20000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          if (body.length < MAX_BODY) body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        res.on('error', (e: NodeJS.ErrnoException) => reject(new HttpError(e.message, e.code)));
      },
    );
    r.on('timeout', () => r.destroy(Object.assign(new Error(`No response from ${u.host} within ${Math.round((req.timeoutMs ?? 20000) / 1000)} s`), { code: 'ETIMEDOUT' })));
    r.on('error', (e: NodeJS.ErrnoException) => reject(new HttpError(e.message, e.code)));
    if (req.body) r.write(req.body);
    r.end();
  });
