export class GitHubAdapter {
  private clientId: string;
  private clientSecret: string;
  private callbackBase: string;

  constructor(clientId: string, clientSecret: string, callbackBase: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackBase = callbackBase;
  }

  getAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: `${this.callbackBase}/api/auth/callback`,
      scope: 'read:user user:email',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async handleCallback(code: string): Promise<{ email: string; displayName: string; providerId: string }> {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        code,
      }),
    });
    const tokenData = await tokenRes.json() as Record<string, unknown>;
    const accessToken = tokenData.access_token as string | undefined;

    if (!accessToken) throw new Error('Failed to get GitHub access token');

    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const user = await userRes.json() as Record<string, unknown>;

    const emailRes = await fetch('https://api.github.com/user/emails', {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const emails = await emailRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified);
    const email = primary?.email || (user.email as string | undefined);

    if (!email) throw new Error('No verified email found on GitHub account');

    return {
      email,
      displayName: (user.name as string) || (user.login as string),
      providerId: String(user.id),
    };
  }
}
