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
    host?: string;
    destinationIP?: string;
    destinationPort?: string;
    network?: string;
    process?: string;
    sourceIP?: string;
  };
};

export type ConnectionSnapshot = {
  downloadTotal?: number;
  uploadTotal?: number;
  connections?: MihomoConnection[];
};

export type ProxyResponse = { proxies?: Record<string, MihomoProxy> };
export type ProviderResponse = { providers?: Record<string, MihomoProvider> };

export class MihomoClient {
  readonly baseUrl: string;
  readonly secret: string;

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
    this.secret = secret;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers);
    if (this.secret) headers.set('Authorization', `Bearer ${this.secret}`);
    if (init?.body) headers.set('Content-Type', 'application/json');

    const response = await fetch(`${this.baseUrl}${path}`, {
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

  closeConnection(id: string) {
    return this.request<void>(`/connections/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async closeConnections(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => this.closeConnection(id)));
    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed) throw new Error(`${failed} 条连接关闭失败，请刷新后重试。`);
  }

  delay(proxyName: string, url: string, timeout = 5000) {
    const query = new URLSearchParams({ url, timeout: String(timeout) });
    return this.request<{ delay: number }>(
      `/proxies/${encodeURIComponent(proxyName)}/delay?${query}`,
    );
  }
}
