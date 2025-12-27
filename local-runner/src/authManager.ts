import crypto from 'node:crypto';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { config } from './config.js';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

export type AuthMode = 'regular' | 'safe_proxy';

export type ApiCreds = {
  apiKey: string;
  secret: string;
  passphrase: string;
};

const mask = (value: string | null | undefined, keep = 4) => {
  if (!value) return '<missing>';
  const v = String(value);
  return `${v.slice(0, keep)}…(len=${v.length})`;
};

const normalizeToBase64 = (input: string) => {
  let s = input.trim();
  // base64url -> base64
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  // strip non-b64
  s = s.replace(/[^A-Za-z0-9+/=]/g, '');

  const pad = s.length % 4;
  if (pad === 2) s += '==';
  if (pad === 3) s += '=';
  return s;
};

const toUrlSafeBase64KeepPadding = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

const buildSignature = (params: {
  secretBytes: Buffer;
  timestampSeconds: string;
  method: string;
  requestPath: string;
  bodyString?: string;
}) => {
  let message = `${params.timestampSeconds}${params.method.toUpperCase()}${params.requestPath}`;
  if (params.bodyString !== undefined) message += params.bodyString;

  const digest = crypto.createHmac('sha256', params.secretBytes).update(message).digest();
  const b64 = Buffer.from(digest).toString('base64');
  // url-safe base64, KEEP padding (=)
  return toUrlSafeBase64KeepPadding(b64);
};

const extractApiKeys = (payload: any): string[] => {
  if (!payload) return [];
  // observed shapes:
  // - { apiKeys: ["uuid", ...] }
  // - [ { apiKey: "uuid", ... }, ... ]
  // - ["uuid", ...]
  if (Array.isArray(payload)) {
    if (payload.length === 0) return [];
    if (typeof payload[0] === 'string') return payload as string[];
    return payload.map((x: any) => x?.apiKey).filter(Boolean);
  }
  if (Array.isArray(payload.apiKeys)) return payload.apiKeys.filter((x: any) => typeof x === 'string');
  return [];
};

const isUnauthorizedPayload = (payload: any): boolean => {
  const status = payload?.status;
  const err = payload?.error;
  if (status === 401) return true;
  if (typeof err === 'string' && err.toLowerCase().includes('unauthorized')) return true;
  return false;
};

const isUnauthorizedError = (err: any): boolean => {
  const status = err?.response?.status ?? err?.status;
  const dataError = err?.response?.data?.error ?? err?.data?.error;
  const msg = String(err?.message || '').toLowerCase();

  if (status === 401) return true;
  if (msg.includes('401') || msg.includes('unauthorized')) return true;
  if (typeof dataError === 'string' && dataError.toLowerCase().includes('unauthorized')) return true;
  return false;
};

export class AuthManager {
  private client: ClobClient | null = null;
  private credsByContext = new Map<string, ApiCreds>();

  private lastContextKey: string | null = null;

  // retry control (prevents infinite loops)
  private deriveBlockedUntilMs = 0;
  private lastDeriveAttemptMs = 0;
  private deriveAttemptsInWindow = 0;
  private deriveWindowStartMs = 0;

  getSigner(): Wallet {
    return new Wallet(config.polymarket.privateKey);
  }

  getSignerAddress(): string {
    return this.getSigner().address;
  }

  getFunderAddress(): string {
    return config.polymarket.address;
  }

  getAuthMode(): AuthMode {
    const signer = this.getSignerAddress().toLowerCase();
    const funder = this.getFunderAddress().toLowerCase();
    return signer === funder ? 'regular' : 'safe_proxy';
  }

  /**
   * signatureType:
   * - EOA wallets: 0
   * - POLY_PROXY (Magic login): 1
   * - GNOSIS_SAFE: 2
   */
  getSignatureType(): 0 | 1 | 2 {
    const override = (config.polymarket as any).signatureType as (0 | 1 | 2 | undefined);
    if (override === 0 || override === 1 || override === 2) return override;
    return this.getAuthMode() === 'safe_proxy' ? 2 : 0;
  }

  /**
   * Which address should be used in POLY_ADDRESS for authenticated requests.
   * Per Polymarket docs, POLY_ADDRESS must be the Polygon SIGNER address (EOA),
   * even when using a Safe (funder) with signatureType=2.
   */
  getPolyAddressHeader(): string {
    return this.getSignerAddress();
  }

  /**
   * Which address balance should be queried for.
   * For Safe proxy, funds live on the Safe.
   */
  getBalanceQueryAddress(): string {
    return this.getAuthMode() === 'safe_proxy' ? this.getFunderAddress() : this.getSignerAddress();
  }

  private getContextKey(): string {
    return `${this.getSignatureType()}:${this.getPolyAddressHeader().toLowerCase()}`;
  }

  private getConfiguredCreds(): ApiCreds {
    return {
      apiKey: config.polymarket.apiKey,
      secret: normalizeToBase64(config.polymarket.apiSecret),
      passphrase: config.polymarket.passphrase,
    };
  }

  private getActiveCreds(): ApiCreds {
    const ctx = this.getContextKey();
    return this.credsByContext.get(ctx) ?? this.getConfiguredCreds();
  }

  private canAttemptDeriveNow(): { ok: boolean; reason?: string } {
    const now = Date.now();
    if (now < this.deriveBlockedUntilMs) {
      return {
        ok: false,
        reason: `auto-derive tijdelijk geblokkeerd (${Math.ceil((this.deriveBlockedUntilMs - now) / 1000)}s)`
      };
    }

    // 1-minute rolling window, max 2 attempts
    const WINDOW_MS = 60_000;
    const MAX_ATTEMPTS = 2;

    if (!this.deriveWindowStartMs || now - this.deriveWindowStartMs > WINDOW_MS) {
      this.deriveWindowStartMs = now;
      this.deriveAttemptsInWindow = 0;
    }

    if (this.deriveAttemptsInWindow >= MAX_ATTEMPTS) {
      return { ok: false, reason: 'auto-derive rate limit hit (max 2/min)' };
    }

    // also prevent immediate spam
    const COOLDOWN_MS = 10_000;
    if (this.lastDeriveAttemptMs && now - this.lastDeriveAttemptMs < COOLDOWN_MS) {
      return { ok: false, reason: `auto-derive cooldown (${Math.ceil((COOLDOWN_MS - (now - this.lastDeriveAttemptMs)) / 1000)}s)` };
    }

    return { ok: true };
  }

  private invalidateClientIfContextChanged(): void {
    const ctx = this.getContextKey();
    if (this.lastContextKey && this.lastContextKey !== ctx) {
      console.log(`🔁 Auth context changed: ${this.lastContextKey} -> ${ctx}. Clearing cached client/creds.`);
      this.client = null;
    }
    this.lastContextKey = ctx;
  }

  private createClientWithCreds(creds?: ApiCreds): ClobClient {
    const signer = this.getSigner();
    const signatureType = this.getSignatureType();

    // IMPORTANT: Per Polymarket docs, POLY_ADDRESS is the signer (EOA) address.
    // The funder (Safe) is passed separately to the client when signatureType=2.
    const apiCreds = creds
      ? (
          {
            // Newer/official field names (per Polymarket docs)
            apiKey: creds.apiKey,
            apiSecret: creds.secret,
            apiPassphrase: creds.passphrase,
            address: this.getPolyAddressHeader(),

            // Back-compat with older clob-client shapes
            key: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
          } as any
        )
      : undefined;

    if (signatureType !== 0) {
      return new ClobClient(CLOB_URL, CHAIN_ID, signer, apiCreds, signatureType, this.getFunderAddress());
    }

    return new ClobClient(CLOB_URL, CHAIN_ID, signer, apiCreds, 0);
  }

  async getClient(): Promise<ClobClient> {
    this.invalidateClientIfContextChanged();
    if (this.client) return this.client;

    const signer = this.getSigner();

    console.log('🔧 Initializing Polymarket CLOB client...');
    console.log(`   mode=${this.getAuthMode()} signatureType=${this.getSignatureType()}`);
    console.log(`   signer=${signer.address}`);
    console.log(`   funder=${this.getFunderAddress()}`);
    console.log(`   POLY_ADDRESS(header)=${this.getPolyAddressHeader()}`);

    const creds = this.getActiveCreds();
    console.log(`   apiKey=${mask(creds.apiKey)}`);

    this.client = this.createClientWithCreds(creds);
    return this.client;
  }

  async validateCreds(): Promise<{ ok: boolean; apiKeys: string[]; activeApiKey: string }> {
    const client = await this.getClient();
    const creds = this.getActiveCreds();

    const res = await (client as any).getApiKeys();
    if (isUnauthorizedPayload(res)) {
      return { ok: false, apiKeys: [], activeApiKey: creds.apiKey };
    }

    const apiKeys = extractApiKeys(res);
    const ok = apiKeys.includes(creds.apiKey);
    return { ok, apiKeys, activeApiKey: creds.apiKey };
  }

  async deriveCreds(reason: string): Promise<ApiCreds> {
    const gate = this.canAttemptDeriveNow();
    if (!gate.ok) throw new Error(`Auto-derive skipped: ${gate.reason}`);

    const now = Date.now();
    this.lastDeriveAttemptMs = now;
    this.deriveAttemptsInWindow += 1;

    console.log(`\n🔄 AUTO-DERIVING NEW API CREDENTIALS... (${reason})`);
    console.log(`   mode=${this.getAuthMode()} signatureType=${this.getSignatureType()}`);

    const temp = this.createClientWithCreds(undefined);

    try {
      const anyClient = temp as any;
      let newCreds: any;

      if (typeof anyClient.createOrDeriveApiKey === 'function') {
        console.log(`   🔑 Deriving or creating API key (createOrDeriveApiKey)...`);
        newCreds = await anyClient.createOrDeriveApiKey();
      } else if (typeof anyClient.createOrDeriveApiCreds === 'function') {
        console.log(`   🔑 Deriving or creating API creds (createOrDeriveApiCreds)...`);
        newCreds = await anyClient.createOrDeriveApiCreds();
      } else if (typeof anyClient.createApiKey === 'function') {
        console.log(`   🔑 Creating new API key (createApiKey)...`);
        newCreds = await anyClient.createApiKey();
      } else {
        throw new Error('SDK missing create/derive credential methods');
      }

      // Handle error payloads (SDK sometimes returns them without throwing)
      if (newCreds?.error || newCreds?.status >= 400) {
        throw new Error(String(newCreds?.error || `derive failed (status=${newCreds?.status})`));
      }

      const apiKey = newCreds?.apiKey ?? newCreds?.key;
      const secretRaw = newCreds?.secret;
      const passphrase = newCreds?.passphrase;

      if (!apiKey || !secretRaw || !passphrase) {
        throw new Error('derive/create returned invalid response (missing fields)');
      }

      const derived: ApiCreds = {
        apiKey: String(apiKey),
        secret: normalizeToBase64(String(secretRaw)),
        passphrase: String(passphrase),
      };

      console.log(`   ✅ Derived creds ready: apiKey=${mask(derived.apiKey)} secret=${mask(derived.secret)} passphrase=${mask(derived.passphrase)}`);

      this.credsByContext.set(this.getContextKey(), derived);
      this.client = null; // force re-init with new creds

      return derived;
    } catch (err: any) {
      const msg = String(err?.message || err);

      // If API key creation is not allowed for this account, stop spamming.
      if (msg.toLowerCase().includes('could not create api key')) {
        this.deriveBlockedUntilMs = Date.now() + 30 * 60 * 1000; // 30 min
        throw new Error(
          `CLOB refused to create API key ("Could not create api key"). ` +
            `Deze account kan waarschijnlijk geen keys via API aanmaken; maak keys handmatig en zet ze in local-runner.env.`
        );
      }

      throw err;
    }
  }

  /**
   * Fetch balance using a signed request (mirrors upstream prehash rules).
   * Returns USDC balance.
   */
  async getBalance(): Promise<{ usdc: number; error?: string; status?: number }> {
    const creds = this.getActiveCreds();

    const usdcAsset = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

    const addr = encodeURIComponent(this.getBalanceQueryAddress());
    const sig = this.getSignatureType();
    const asset = encodeURIComponent(usdcAsset.toLowerCase());

    const candidatePaths = [
      `/balance-allowance?asset_type=collateral&asset_address=${asset}&signature_type=${sig}&address=${addr}`,
      `/balance-allowance?asset_type=collateral&assetAddress=${asset}&signature_type=${sig}&address=${addr}`,
      `/balance-allowance?asset_type=collateral&signature_type=${sig}&address=${addr}`,
      `/balance-allowance?asset_type=0&asset_address=${asset}&signature_type=${sig}&address=${addr}`,
      `/balance-allowance?asset_type=0&assetAddress=${asset}&signature_type=${sig}&address=${addr}`,
      `/balance-allowance?asset_type=0&signature_type=${sig}&address=${addr}`,
    ];

    const timestampSeconds = String(Math.floor(Date.now() / 1000));

    const secretBytes = Buffer.from(normalizeToBase64(creds.secret), 'base64');
    if (!secretBytes?.length) return { usdc: 0, error: 'Invalid API secret (base64 decode failed)' };

    let lastErr: { status?: number; error: string } | null = null;

    for (const pathWithQuery of candidatePaths) {
      const signature = buildSignature({
        secretBytes,
        timestampSeconds,
        method: 'GET',
        requestPath: pathWithQuery,
      });

      const res = await fetch(`${CLOB_URL}${pathWithQuery}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          POLY_ADDRESS: this.getPolyAddressHeader(),
          POLY_API_KEY: creds.apiKey,
          POLY_PASSPHRASE: creds.passphrase,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: timestampSeconds,
        } as any,
      });

      if (!res.ok) {
        const text = await res.text();
        lastErr = { status: res.status, error: text.slice(0, 300) };
        console.error(`❌ Balance attempt failed: status=${res.status} path=${pathWithQuery} body=${lastErr.error}`);
        if (res.status === 400) continue;
        return { usdc: 0, error: lastErr.error, status: lastErr.status };
      }

      const data = await res.json();
      const rawBalance = (data as any)?.balance ?? (data as any)?.available_balance ?? '0';
      const balance = typeof rawBalance === 'number' ? rawBalance : parseFloat(String(rawBalance));
      return { usdc: Number.isFinite(balance) ? balance : 0 };
    }

    return { usdc: 0, error: lastErr?.error ?? 'Unknown error', status: lastErr?.status };

    const data = await res.json();
    const rawBalance = (data as any)?.balance ?? (data as any)?.available_balance ?? '0';
    const balance = typeof rawBalance === 'number' ? rawBalance : parseFloat(String(rawBalance));
    return { usdc: Number.isFinite(balance) ? balance : 0 };
  }

  async selfTest(): Promise<{ ok: boolean; details: string[] }> {
    const details: string[] = [];

    details.push(`mode=${this.getAuthMode()} signatureType=${this.getSignatureType()}`);
    details.push(`signer=${this.getSignerAddress()}`);
    details.push(`funder=${this.getFunderAddress()}`);
    details.push(`POLY_ADDRESS(header)=${this.getPolyAddressHeader()}`);

    // 1) getApiKeys
    try {
      const v = await this.validateCreds();
      details.push(`getApiKeys: ${v.ok ? 'OK' : 'FAIL'} (active=${mask(v.activeApiKey)} keys=${v.apiKeys.length})`);
      if (!v.ok) {
        details.push(`api key not found in list (possible address mismatch or stale key)`);
      }
    } catch (e: any) {
      const msg = String(e?.message || e);
      details.push(`getApiKeys: ERROR ${msg}`);
      if (isUnauthorizedError(e) || msg.toLowerCase().includes('unauthorized')) {
        details.push('unauthorized: api key likely invalid for this POLY_ADDRESS / account mode');
      }
    }

    // 2) balance
    try {
      const b = await this.getBalance();
      if (b.error) {
        details.push(`balance: FAIL status=${b.status ?? '?'} err=${b.error}`);
      } else {
        details.push(`balance: OK usdc=${b.usdc.toFixed(2)}`);
      }
    } catch (e: any) {
      details.push(`balance: ERROR ${String(e?.message || e)}`);
    }

    const ok = details.some((d) => d.startsWith('balance: OK'));
    return { ok, details };
  }
}

export const authManager = new AuthManager();
