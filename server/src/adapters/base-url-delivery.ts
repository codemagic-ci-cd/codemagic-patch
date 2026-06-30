import type { DeliveryAdapter, PurgeResult } from "./delivery";

export interface BaseUrlDeliveryAdapterOptions {
  baseUrl: string;
}

export class BaseUrlDeliveryAdapter implements DeliveryAdapter {
  private readonly baseUrl: string;

  constructor(options: BaseUrlDeliveryAdapterOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
  }

  resolveUrl(publicKey: string): string {
    const normalizedKey = publicKey.replace(/^\/+/, "");
    return `${this.baseUrl}/${normalizedKey}`;
  }

  async purge(paths: string[]): Promise<PurgeResult> {
    return {
      failures: [],
      requested: paths.length,
      succeeded: paths.length,
    };
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();

  if (trimmed.length === 0) {
    throw new Error("PUBLIC_BASE_URL must not be empty");
  }

  return trimmed.replace(/\/+$/, "");
}
