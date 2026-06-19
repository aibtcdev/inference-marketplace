/**
 * Cloudflare tunnel provisioning.
 *
 * The marketplace owns the Cloudflare account + domain. When a provider connects
 * a local model, the gateway provisions a remotely-managed tunnel that forwards
 * a hostname we own (`<id>.providers.aibtc.com`) to the provider's local auth
 * proxy. The provider then runs a single `cloudflared --token …` connector — no
 * Cloudflare account, no domain, no dashboard on their side.
 *
 * Requires (Worker secrets/vars): CF_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID,
 * CF_PROVIDER_DOMAIN (e.g. "providers.aibtc.com").
 */

export interface CfEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  CF_PROVIDER_DOMAIN?: string;
}

const API = 'https://api.cloudflare.com/client/v4';

export function cloudflareConfigured(env: CfEnv): boolean {
  return Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.CF_ZONE_ID && env.CF_PROVIDER_DOMAIN);
}

async function cf<T = any>(env: CfEnv, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: unknown };
  if (!res.ok || json.success === false) {
    throw new Error(`Cloudflare ${path} → ${res.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.result as T;
}

export interface ProvisionResult {
  tunnelId: string;
  token: string; // connector token for `cloudflared tunnel run --token <token>`
  hostname: string; // <subId>.providers.aibtc.com
}

/**
 * Create a tunnel → point a hostname at the provider's local proxy port →
 * publish a proxied CNAME. Returns the connector token + the public hostname.
 */
export async function provisionTunnel(env: CfEnv, opts: { subId: string; servicePort: number }): Promise<ProvisionResult> {
  const hostname = `${opts.subId}.${env.CF_PROVIDER_DOMAIN}`;

  // 1) Create a remotely-managed tunnel.
  const tunnel = await cf<{ id: string; token?: string }>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel`, {
    method: 'POST',
    body: JSON.stringify({ name: `marketplace-${opts.subId}`, config_src: 'cloudflare' }),
  });
  const tunnelId = tunnel.id;

  // Connector token — present on create for cloudflare-managed tunnels, else fetch.
  const token = tunnel.token ?? (await cf<string>(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/token`));

  // 2) Ingress: hostname → the provider's local auth proxy.
  await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
    method: 'PUT',
    body: JSON.stringify({
      config: {
        ingress: [
          { hostname, service: `http://localhost:${opts.servicePort}` },
          { service: 'http_status:404' },
        ],
      },
    }),
  });

  // 3) Proxied CNAME → tunnel.
  await cf(env, `/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: 'POST',
    body: JSON.stringify({ type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, proxied: true }),
  });

  return { tunnelId, token, hostname };
}

/** Best-effort teardown when a provider is removed. */
export async function deprovisionTunnel(env: CfEnv, tunnelId: string): Promise<void> {
  try {
    await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}`, { method: 'DELETE' });
  } catch { /* best effort */ }
}
