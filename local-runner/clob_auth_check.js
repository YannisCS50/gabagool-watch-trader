#!/usr/bin/env node
import crypto from "node:crypto";

const BASE_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const API_KEY = process.env.POLYMARKET_API_KEY || process.env.POLY_API_KEY || "";
const API_SECRET = process.env.POLYMARKET_API_SECRET || process.env.POLY_API_SECRET || "";
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE || process.env.POLY_PASSPHRASE || "";
const ADDRESS = process.env.POLYMARKET_ADDRESS || process.env.POLY_ADDRESS || "";

const DEFAULT_ENDPOINTS = [
  "/auth/api-keys",
  "/auth/me",
  "/auth/whoami",
  "/auth/keys",
  "/auth/info",
  "/account",
  "/account/balance",
  "/balance",
  "/positions",
  "/orders",
];

const encoder = new TextEncoder();

const mask = (value) => {
  if (!value) return "<missing>";
  const prefix = value.slice(0, 4);
  return `${prefix}…(len=${value.length})`;
};

const toBase64Url = (input) =>
  input.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const fromBase64Url = (input) => {
  let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4;
  if (pad === 2) normalized += "==";
  if (pad === 3) normalized += "=";
  return normalized;
};

const decodeSecret = (secret, variant) => {
  if (!secret) return null;
  try {
    const normalized = variant === "base64url" ? fromBase64Url(secret) : secret;
    return Buffer.from(normalized, "base64");
  } catch (error) {
    return null;
  }
};

const encodeSignature = (digest, variant) => {
  const base64 = Buffer.from(digest).toString("base64");
  return variant === "base64url" ? toBase64Url(base64) : base64;
};

const buildPrehash = ({ timestamp, method, path, bodyString }) => {
  const normalizedMethod = method.toUpperCase();
  return `${timestamp}${normalizedMethod}${path}${bodyString || ""}`;
};

const buildHeaders = ({ timestamp, signature }) => ({
  "Content-Type": "application/json",
  POLY_ADDRESS: ADDRESS,
  POLY_API_KEY: API_KEY,
  POLY_PASSPHRASE: PASSPHRASE,
  POLY_SIGNATURE: signature,
  POLY_TIMESTAMP: timestamp,
});

const request = async ({ method, path, headers, bodyString }) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: bodyString && method !== "GET" ? bodyString : undefined,
  });
  const text = await response.text();
  return { response, text };
};

const getServerTimeSkewMs = async () => {
  try {
    const response = await fetch(BASE_URL, { method: "GET" });
    const dateHeader = response.headers.get("date");
    if (!dateHeader) return { skewMs: null, serverDate: null };
    const serverDate = new Date(dateHeader);
    const skewMs = Date.now() - serverDate.getTime();
    return { skewMs, serverDate: serverDate.toISOString() };
  } catch (error) {
    return { skewMs: null, serverDate: null };
  }
};

const probeEndpoint = async () => {
  for (const path of DEFAULT_ENDPOINTS) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, { method: "GET" });
      if (![404, 405].includes(response.status)) {
        return path;
      }
    } catch (error) {
      // ignore network errors for probe
    }
  }
  return DEFAULT_ENDPOINTS[0];
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

  const { skewMs, serverDate } = await getServerTimeSkewMs();
  if (skewMs !== null) {
    console.log(`Clock skew check: local=${new Date().toISOString()} server=${serverDate} deltaMs=${skewMs}`);
  } else {
    console.log("Clock skew check: unable to read server date header.");
  }

  const endpoint = await probeEndpoint();
  console.log(`Using auth probe endpoint: ${endpoint}`);

  const secretVariants = [
    { label: "base64url", bytes: decodeSecret(API_SECRET, "base64url") },
    { label: "base64", bytes: decodeSecret(API_SECRET, "base64") },
  ].filter((variant) => variant.bytes && variant.bytes.length > 0);

  const signatureVariants = ["base64", "base64url"];

  let saw401 = false;

  for (const secretVariant of secretVariants) {
    for (const signatureVariant of signatureVariants) {
      const timestamp = Date.now().toString();
      const method = "GET";
      const prehash = buildPrehash({ timestamp, method, path: endpoint });
      const digest = crypto.createHmac("sha256", secretVariant.bytes).update(encoder.encode(prehash)).digest();
      const signature = encodeSignature(digest, signatureVariant);
      const headers = buildHeaders({ timestamp, signature });

      console.log("\nAuth attempt:");
      console.log(`  endpoint=${endpoint} method=${method}`);
      console.log(`  apiKey=${mask(API_KEY)} passphrase=${mask(PASSPHRASE)} address=${mask(ADDRESS)}`);
      console.log(`  secretVariant=${secretVariant.label} signatureVariant=${signatureVariant}`);
      console.log(`  signature=${mask(signature)}`);
      console.log(`  prehashLen=${prehash.length} prehashPreview=${prehash.slice(0, 24)}…`);

      const { response, text } = await request({ method, path: endpoint, headers });
      console.log(`  status=${response.status}`);
      console.log(`  body=${text.slice(0, 500)}`);

      if (response.status >= 200 && response.status < 300) {
        console.log("Auth success.");
        process.exit(0);
      }

      if (response.status === 401) {
        saw401 = true;
      }
    }
  }

  if (saw401) {
    process.exit(1);
  }

  process.exit(2);
};

run();
