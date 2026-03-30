import * as client from 'openid-client';

interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  tenant?: string;
}

export interface OAuthManagerConfig {
  google?: ProviderConfig;
  microsoft?: ProviderConfig;
}

const DISCOVERY_URLS: Record<string, string | ((config: ProviderConfig) => string)> = {
  google: 'https://accounts.google.com',
  microsoft: (config) =>
    `https://login.microsoftonline.com/${config.tenant || 'common'}/v2.0`,
};

export class OAuthManager {
  private config: OAuthManagerConfig;
  private callbackBase: string;
  private configurations: Map<string, client.Configuration> = new Map();

  constructor(config: OAuthManagerConfig, callbackBase: string) {
    this.config = config;
    this.callbackBase = callbackBase;
  }

  getSupportedProviders(): string[] {
    return Object.keys(this.config).filter(
      k => this.config[k as keyof OAuthManagerConfig]
    );
  }

  async getAuthUrl(provider: string, state: string): Promise<string> {
    const config = await this.getConfiguration(provider);
    const url = client.buildAuthorizationUrl(config, {
      scope: 'openid email profile',
      state,
      redirect_uri: `${this.callbackBase}/api/auth/callback`,
    });
    return url.href;
  }

  async handleCallback(
    provider: string,
    currentUrl: URL,
    state: string,
  ): Promise<{ email: string; displayName: string; providerId: string }> {
    const config = await this.getConfiguration(provider);
    const tokenResponse = await client.authorizationCodeGrant(config, currentUrl, {
      expectedState: state,
    });

    const claims = tokenResponse.claims();
    if (!claims) throw new Error('No ID token claims returned');

    return {
      email: claims.email as string,
      displayName: (claims.name as string) || (claims.email as string),
      providerId: claims.sub,
    };
  }

  private async getConfiguration(provider: string): Promise<client.Configuration> {
    if (this.configurations.has(provider)) return this.configurations.get(provider)!;

    const providerConfig = this.config[provider as keyof OAuthManagerConfig];
    if (!providerConfig) throw new Error(`Provider "${provider}" not configured`);

    const discoveryUrl = DISCOVERY_URLS[provider];
    if (!discoveryUrl) throw new Error(`No discovery URL for provider "${provider}"`);

    const url = typeof discoveryUrl === 'function' ? discoveryUrl(providerConfig) : discoveryUrl;

    const config = await client.discovery(
      new URL(url),
      providerConfig.clientId,
      {
        client_secret: providerConfig.clientSecret,
        redirect_uris: [`${this.callbackBase}/api/auth/callback`],
        response_types: ['code'],
      },
      client.ClientSecretPost(providerConfig.clientSecret),
    );

    this.configurations.set(provider, config);
    return config;
  }
}
