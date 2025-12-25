import dotenv from "dotenv";

dotenv.config();

const getRequired = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const parseNumber = (key, fallback) => {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid numeric env var: ${key}`);
  }
  return parsed;
};

export const config = {
  pk: getRequired("PK"),
  clobApiKey: getRequired("CLOB_API_KEY"),
  clobApiSecret: getRequired("CLOB_API_SECRET"),
  clobApiPassphrase: getRequired("CLOB_API_PASSPHRASE"),
  signatureType: parseNumber("SIGNATURE_TYPE", 0),
  desiredOutcome: (process.env.DESIRED_OUTCOME || "Up").toLowerCase(),
  side: (process.env.SIDE || "BUY").toUpperCase(),
  price: getRequired("PRICE"),
  size: getRequired("SIZE"),
  pollMs: parseNumber("POLL_MS", 1500),
  maxWaitMs: parseNumber("MAX_WAIT_MS", 300000),
  stateFile: process.env.STATE_FILE || "/data/state.json",
  gammaBase: "https://gamma-api.polymarket.com",
  clobHost: "https://clob.polymarket.com",
  chainId: 137,
};

const allowedSides = new Set(["BUY", "SELL"]);
if (!allowedSides.has(config.side)) {
  throw new Error(`SIDE must be BUY or SELL, got: ${config.side}`);
}
