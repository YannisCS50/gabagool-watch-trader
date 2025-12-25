#!/usr/bin/env node
const BASE_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const API_KEY = process.env.POLYMARKET_API_KEY || process.env.POLY_API_KEY || "";
const API_SECRET = process.env.POLYMARKET_API_SECRET || process.env.POLY_API_SECRET || "";
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE || process.env.POLY_PASSPHRASE || "";
const ADDRESS = process.env.POLYMARKET_ADDRESS || process.env.POLY_ADDRESS || "";

const mask = (value) => {
  if (!value) return "<missing>";
  const prefix = value.slice(0, 4);
  return `${prefix}…(len=${value.length})`;
};

const logHeaderSnapshot = (headers) => {
  const sanitized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (typeof value !== "string") {
      sanitized[key] = value;
      continue;
    }
    if (key.toUpperCase().includes("SECRET")) {
      sanitized[key] = mask(value);
      continue;
    }
    if (["POLY_SIGNATURE", "POLY_PASSPHRASE"].includes(key)) {
      sanitized[key] = mask(value);
      continue;
    }
    sanitized[key] = value;
  }
  console.log("SDK request headers:", sanitized);
};

const run = async () => {
  if (!API_KEY || !API_SECRET || !PASSPHRASE || !ADDRESS) {
    console.error("Missing required env vars:");
    console.error(`POLYMARKET_API_KEY=${mask(API_KEY)}`);
    console.error(`POLYMARKET_API_SECRET=${mask(API_SECRET)}`);
    console.error(`POLYMARKET_PASSPHRASE=${mask(PASSPHRASE)}`);
    console.error(`POLYMARKET_ADDRESS=${mask(ADDRESS)}`);
    process.exit(1);
  }

  const sdkModule = await import("@polymarket/clob-client").catch((error) => {
    console.error("Failed to import @polymarket/clob-client. Install it and retry.");
    console.error(String(error));
    return null;
  });

  if (!sdkModule) {
    process.exit(2);
  }

  const { ClobClient } = sdkModule;
  if (!ClobClient) {
    console.error("@polymarket/clob-client did not export ClobClient.");
    console.error("Available exports:", Object.keys(sdkModule));
    process.exit(2);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const headers = options.headers && typeof options.headers.forEach === "function"
      ? Object.fromEntries(options.headers.entries())
      : options.headers || {};
    logHeaderSnapshot(headers);
    return originalFetch(url, options);
  };

  const client = new ClobClient(
    BASE_URL,
    137,
    undefined,
    {
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      apiPassphrase: PASSPHRASE,
      address: ADDRESS,
    }
  );

  if (typeof client.getApiKeys !== "function") {
    console.error("ClobClient.getApiKeys not found. Available methods:", Object.keys(client));
    process.exit(2);
  }

  const result = await client.getApiKeys();
  console.log("SDK getApiKeys result:", result);
};

run();
