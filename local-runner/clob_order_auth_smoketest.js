#!/usr/bin/env node
import crypto from "node:crypto";

const BASE_URL = process.env.POLYMARKET_CLOB_URL || "https://clob.polymarket.com";
const API_KEY = process.env.POLYMARKET_API_KEY || process.env.POLY_API_KEY || "";
const API_SECRET = process.env.POLYMARKET_API_SECRET || process.env.POLY_API_SECRET || "";
const PASSPHRASE = process.env.POLYMARKET_PASSPHRASE || process.env.POLY_PASSPHRASE || "";
const ADDRESS = process.env.POLYMARKET_ADDRESS || process.env.POLY_ADDRESS || "";

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
    body: bodyString,
  });
  const text = await response.text();
  return { response, text };
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

  const orderPayload = {
    // intentionally invalid payload: expect 400/422 if auth is correct
    market: "0x0000000000000000000000000000000000000000",
    side: "BUY",
    price: "0",
    size: "0",
    orderType: "INVALID",
  };

  const bodyString = JSON.stringify(orderPayload);
  const pathsToTry = ["/order", "/orders"];
  const secretVariants = [
    { label: "base64url", bytes: decodeSecret(API_SECRET, "base64url") },
    { label: "base64", bytes: decodeSecret(API_SECRET, "base64") },
  ].filter((variant) => variant.bytes && variant.bytes.length > 0);
  const signatureVariants = ["base64", "base64url"];

  let saw401 = false;

  for (const path of pathsToTry) {
    for (const secretVariant of secretVariants) {
      for (const signatureVariant of signatureVariants) {
        const timestamp = Date.now().toString();
        const method = "POST";
        const prehash = buildPrehash({ timestamp, method, path, bodyString });
        const digest = crypto.createHmac("sha256", secretVariant.bytes).update(encoder.encode(prehash)).digest();
        const signature = encodeSignature(digest, signatureVariant);
        const headers = buildHeaders({ timestamp, signature });

        console.log("\nOrder auth attempt:");
        console.log(`  path=${path} method=${method}`);
        console.log(`  apiKey=${mask(API_KEY)} passphrase=${mask(PASSPHRASE)} address=${mask(ADDRESS)}`);
        console.log(`  secretVariant=${secretVariant.label} signatureVariant=${signatureVariant}`);
        console.log(`  signature=${mask(signature)}`);
        console.log(`  prehashLen=${prehash.length} prehashPreview=${prehash.slice(0, 24)}…`);

        const { response, text } = await request({ method, path, headers, bodyString });
        console.log(`  status=${response.status}`);
        console.log(`  body=${text.slice(0, 500)}`);

        if ([400, 422].includes(response.status)) {
          console.log("Auth appears valid (non-401 response).");
          process.exit(0);
        }

        if (response.status === 401) {
          saw401 = true;
        }
      }
    }
  }

  if (saw401) {
    process.exit(1);
  }

  process.exit(2);
};

run();
