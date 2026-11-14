import { clipboard, shell } from 'electron';
import type { Account } from '../shared/types.js';
import { getAccountSecret, redactAccount, saveAccount } from './store.js';
import { fetchTimeout, json } from './util.js';

const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const DEVICE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const SCOPE = 'XboxLive.signin offline_access';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_HOSTS = /(^|\.)(microsoft\.com|microsoftonline\.com|live\.com|aka\.ms)$/i;

type OAuthResponse = { access_token?: string; refresh_token?: string; error?: string; error_description?: string };
type Xbox = { Token: string; DisplayClaims: { xui: { uhs: string }[] } };

async function postForm<T>(url: string, fields: Record<string, string>): Promise<T> {
  const response = await fetchTimeout(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  const body = await response.text();
  try { return JSON.parse(body) as T; } catch { throw new Error(`Microsoft sign-in returned an unexpected response (${response.status}).`); }
}

const XSTS_ERRORS: Record<number, string> = {
  2148916233: 'This Microsoft account has no Xbox profile yet. Sign in once at xbox.com to create one.',
  2148916235: 'Xbox Live is not available in your country/region.',
  2148916238: 'This is a child account. An adult must add it to a Microsoft family before it can play online.'
};

async function minecraftSession(microsoftToken: string): Promise<Pick<Account, 'name' | 'uuid' | 'accessToken' | 'expiresAt'>> {
  const live = await json<Xbox>('https://user.auth.xboxlive.com/user/authenticate', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${microsoftToken}` }, RelyingParty: 'http://auth.xboxlive.com', TokenType: 'JWT' }) });
  const xstsResponse = await fetchTimeout('https://xsts.auth.xboxlive.com/xsts/authorize', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ Properties: { SandboxId: 'RETAIL', UserTokens: [live.Token] }, RelyingParty: 'rp://api.minecraftservices.com/', TokenType: 'JWT' }) });
  const xsts = await xstsResponse.json().catch(() => ({})) as Xbox & { XErr?: number };
  if (!xstsResponse.ok) throw new Error(XSTS_ERRORS[xsts.XErr ?? 0] ?? `Xbox Live sign-in failed (${xstsResponse.status}).`);
  const identity = `XBL3.0 x=${xsts.DisplayClaims.xui[0].uhs};${xsts.Token}`;

  const loginResponse = await fetchTimeout('https://api.minecraftservices.com/authentication/login_with_xbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityToken: identity }) });
  if (loginResponse.status === 403) throw new Error('Minecraft rejected this app registration (403). New Microsoft Entra apps must be approved by Mojang before they can sign players in; see the README.');
  if (!loginResponse.ok) throw new Error(`Minecraft sign-in failed (${loginResponse.status}).`);
  const login = await loginResponse.json() as { access_token: string; expires_in?: number };

  const profileResponse = await fetchTimeout('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${login.access_token}` } });
  if (profileResponse.status === 404) throw new Error('This Microsoft account does not own Minecraft: Java Edition (or has not created a profile yet).');
  if (!profileResponse.ok) throw new Error(`Could not read the Minecraft profile (${profileResponse.status}).`);
  const profile = await profileResponse.json() as { id: string; name: string };
  return { name: profile.name, uuid: profile.id, accessToken: login.access_token, expiresAt: Date.now() + (login.expires_in ?? 86400) * 1000 };
}

export async function microsoftDeviceLogin(clientId: string, send: (message: string) => void): Promise<Account> {
  if (!GUID.test(clientId)) throw new Error('Enter a valid Microsoft public client ID (a GUID) in Settings, or set VITE_MICROSOFT_CLIENT_ID in .env.');
  const device = await postForm<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval?: number; error?: string; error_description?: string }>(DEVICE_URL, { client_id: clientId, scope: SCOPE });
  if (!device.device_code) throw new Error(device.error_description || device.error || 'Microsoft did not start the device sign-in.');

  clipboard.writeText(device.user_code);
  try { if (OPEN_HOSTS.test(new URL(device.verification_uri).hostname) && device.verification_uri.startsWith('https://')) void shell.openExternal(device.verification_uri); } catch { /* the message below still tells the user what to do */ }
  send(`Enter code ${device.user_code} at ${device.verification_uri} (the code is copied to your clipboard).`);

  let interval = (device.interval ?? 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  let tokens: OAuthResponse | undefined;
  while (!tokens && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, interval));
    const value = await postForm<OAuthResponse>(TOKEN_URL, { client_id: clientId, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code });
    if (value.access_token) tokens = value;
    else if (value.error === 'slow_down') interval += 5000;
    else if (value.error !== 'authorization_pending') throw new Error(value.error === 'authorization_declined' ? 'Microsoft sign-in was cancelled.' : value.error_description || value.error || 'Microsoft sign-in failed.');
  }
  if (!tokens?.access_token) throw new Error('Microsoft sign-in timed out. Try again.');
  const session = await minecraftSession(tokens.access_token);
  return redactAccount(await saveAccount({ ...session, refreshToken: tokens.refresh_token, clientId }));
}

/** Returns a Minecraft session that is valid for at least 5 more minutes, refreshing it if needed. */
export async function freshAccount(): Promise<Account> {
  const account = await getAccountSecret();
  if (!account || account.accessToken === 'offline') throw new Error('Sign in with Microsoft first.');
  if (account.expiresAt - Date.now() > 5 * 60 * 1000) return account;
  if (!account.refreshToken || !account.clientId) throw new Error('Your Microsoft session expired. Sign in again in Settings.');
  const refreshed = await postForm<OAuthResponse>(TOKEN_URL, { client_id: account.clientId, grant_type: 'refresh_token', refresh_token: account.refreshToken, scope: SCOPE });
  if (!refreshed.access_token) throw new Error('Your Microsoft session expired. Sign in again in Settings.');
  const session = await minecraftSession(refreshed.access_token);
  return saveAccount({ ...account, ...session, refreshToken: refreshed.refresh_token ?? account.refreshToken });
}

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function uploadSkin(data: Uint8Array, variant: 'classic' | 'slim'): Promise<Account> {
  const account = await freshAccount();
  if (data.length > 1024 * 1024) throw new Error('Skin file is too large (max 1 MB).');
  if (!Buffer.from(data.subarray(0, 8)).equals(PNG)) throw new Error('Skins must be PNG files.');
  const body = new FormData();
  body.append('variant', variant);
  body.append('file', new Blob([Buffer.from(data)], { type: 'image/png' }), 'skin.png');
  const response = await fetchTimeout('https://api.minecraftservices.com/minecraft/profile/skins', { method: 'POST', headers: { Authorization: `Bearer ${account.accessToken}` }, body });
  if (!response.ok) throw new Error(`Minecraft skin upload failed: ${response.status} ${response.statusText}`);
  const profile = await response.json() as { skins?: { state?: string; url?: string }[] };
  const active = profile.skins?.find(skin => skin.state === 'ACTIVE');
  return redactAccount(await saveAccount({ ...account, skinUrl: active?.url, skinVariant: variant }));
}
