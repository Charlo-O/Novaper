import { ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";

export interface ProxyStatus {
  enabled: boolean;
  url?: string;
  source?: string;
}

let proxyDispatcher: Dispatcher | undefined;
let proxyStatus: ProxyStatus = { enabled: false };

function normalizeProxyUrl(value?: string | null) {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveProxySetting() {
  const entries: Array<{ source: string; value?: string }> = [
    { source: "NOVAPER_PROXY_URL", value: process.env.NOVAPER_PROXY_URL },
    { source: "HTTPS_PROXY", value: process.env.HTTPS_PROXY },
    { source: "HTTP_PROXY", value: process.env.HTTP_PROXY },
    { source: "ALL_PROXY", value: process.env.ALL_PROXY },
  ];

  for (const entry of entries) {
    const url = normalizeProxyUrl(entry.value);
    if (url) {
      return {
        url,
        source: entry.source,
      };
    }
  }

  return undefined;
}

export function configureNetworkProxy() {
  if (proxyDispatcher) {
    return proxyStatus;
  }

  const proxy = resolveProxySetting();
  if (!proxy) {
    proxyStatus = { enabled: false };
    return proxyStatus;
  }

  proxyDispatcher = new ProxyAgent(proxy.url);
  setGlobalDispatcher(proxyDispatcher);
  proxyStatus = {
    enabled: true,
    url: proxy.url,
    source: proxy.source,
  };
  return proxyStatus;
}

export function getProxyDispatcher() {
  return proxyDispatcher;
}

export function getProxyStatus() {
  return proxyStatus;
}
