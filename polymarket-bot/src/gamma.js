import axios from "axios";
import { config } from "./config.js";
import { logger } from "./log.js";

const client = axios.create({
  baseURL: config.gammaBase,
  timeout: 10_000,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, { retries = 5, baseDelay = 500 } = {}) => {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const status = error.response?.status;
      const retriable = !status || status >= 500 || status === 429;
      if (!retriable || attempt > retries) {
        throw error;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.warn({ attempt, delay, status }, "Gamma request failed, retrying");
      await sleep(delay);
    }
  }
};

export const fetchLatestEvent = async () => {
  const response = await withRetry(() =>
    client.get("/events", {
      params: {
        order: "id",
        ascending: "false",
        closed: "false",
        limit: 100,
      },
    })
  );

  const events = response.data || [];
  const candidates = events.filter((evt) =>
    evt.slug?.startsWith("btc-updown-15m-")
  );

  if (!candidates.length) {
    return null;
  }

  const sorted = candidates.sort((a, b) => {
    const aSuffix = Number(a.slug?.split("btc-updown-15m-")[1] || 0);
    const bSuffix = Number(b.slug?.split("btc-updown-15m-")[1] || 0);
    if (!Number.isNaN(bSuffix) && !Number.isNaN(aSuffix) && bSuffix !== aSuffix) {
      return bSuffix - aSuffix;
    }
    return (b.id || 0) - (a.id || 0);
  });

  return sorted[0];
};

const parseMaybeJson = (value) => {
  if (!value) return value;
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }
  return value;
};

export const pickTokenIdForOutcome = (market, outcomeLabel) => {
  const outcomes = parseMaybeJson(market.outcomes) || [];
  const tokenIds = parseMaybeJson(market.clobTokenIds) || [];
  const target = outcomeLabel.toLowerCase();
  const index = outcomes.findIndex(
    (item) => String(item).toLowerCase() === target
  );
  if (index === -1 || !tokenIds[index]) {
    throw new Error(
      `Outcome not found: ${outcomeLabel} in ${JSON.stringify(outcomes)}`
    );
  }
  return tokenIds[index];
};

export const waitForTradable = async ({ pollMs, maxWaitMs }) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const event = await fetchLatestEvent();
    if (!event) {
      logger.info("No BTC 15m events found yet");
    } else {
      const isReady = event.ready === true;
      const isFunded = event.funded === true;
      const market = (event.markets || []).find(
        (m) => m.enableOrderBook && m.acceptingOrders
      );

      if (isReady && isFunded && market) {
        return { event, market };
      }

      logger.info(
        {
          slug: event.slug,
          ready: event.ready,
          funded: event.funded,
          hasOrderBookMarket: Boolean(market),
        },
        "Event not tradable yet"
      );
    }

    await sleep(pollMs);
  }

  throw new Error("Timed out waiting for tradable event");
};
