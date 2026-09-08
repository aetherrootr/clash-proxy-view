export type MihomoHistory = {
  time?: string;
  delay?: number;
};

export type MihomoProxy = {
  name: string;
  type?: string;
  alive?: boolean;
  now?: string;
  all?: string[];
  history?: MihomoHistory[];
};

export type MihomoProvider = {
  name?: string;
  type?: string;
  vehicleType?: string;
  updatedAt?: string;
  proxies?: MihomoProxy[];
};

export type MihomoConnection = {
  id: string;
  upload: number;
  download: number;
  start?: string;
  chains?: string[];
  providerChains?: string[];
  metadata?: {
    type?: string;
    host?: string;
    destinationIP?: string;
    destinationPort?: string;
    network?: string;
    process?: string;
    processPath?: string;
    sourceIP?: string;
    sourcePort?: string;
  };
};

export type ConnectionSnapshot = {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: MihomoConnection[];
};

export type ProxyResponse = { proxies?: Record<string, MihomoProxy> };
export type ProviderResponse = { providers?: Record<string, MihomoProvider> };

function isEmbeddedDashboard() {
  return typeof window !== 'undefined'
    && /^\/ui\/proxy-view(?:\/|$)/.test(window.location.pathname);
}

export class MihomoClient {
  readonly baseUrl: string;
  readonly secret: string;

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.secret = secret;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const embedded = isEmbeddedDashboard();
    const headers = new Headers(init?.headers);
    if (!embedded) headers.set('X-Mihomo-Endpoint', this.baseUrl);
    if (this.secret) headers.set('Authorization', `Bearer ${this.secret}`);
    if (init?.body) headers.set('Content-Type', 'application/json');

    const requestUrl = embedded
      ? new URL(path, `${this.baseUrl}/`).toString()
      : `/api/mihomo${path}`;
    const response = await fetch(requestUrl, {
      ...init,
      headers,
      cache: 'no-store',
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        response.status === 401
          ? '认证失败，请检查 API 密钥。'
          : `Mihomo API 返回 ${response.status}${detail ? `：${detail}` : ''}`,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  version() {
    return this.request<{ version?: string; meta?: boolean }>('/version');
  }

  providers() {
    return this.request<ProviderResponse>('/providers/proxies');
  }

  proxies() {
    return this.request<ProxyResponse>('/proxies');
  }

  connections() {
    return this.request<ConnectionSnapshot>('/connections');
  }

  delay(proxyName: string, url: string, timeout = 5000) {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    return this.request<{ delay: number }>(
      `/proxies/${encodeURIComponent(proxyName)}/delay?${query}`,
    );
  }
}
