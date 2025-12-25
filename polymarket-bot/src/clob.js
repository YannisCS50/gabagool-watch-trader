import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { config } from "./config.js";
import { logger } from "./log.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createClient = () => {
  const wallet = new Wallet(config.pk);
  return new ClobClient(
    config.clobHost,
    config.chainId,
    wallet,
    {
      apiKey: config.clobApiKey,
      apiSecret: config.clobApiSecret,
      apiPassphrase: config.clobApiPassphrase,
      address: wallet.address,
    },
    config.signatureType
  );
};

export const preflightOrderBook = async (client, tokenId) => {
  while (true) {
    try {
      const orderBook = await client.getOrderBook(tokenId);
      return orderBook;
    } catch (error) {
      const message = error?.message || "";
      const status = error?.response?.status;
      const body = error?.response?.data;
      const bodyString = body ? JSON.stringify(body) : "";
      const isMissing =
        message.toLowerCase().includes("orderbook") ||
        bodyString.toLowerCase().includes("orderbook");

      if (isMissing) {
        logger.warn({ tokenId, status }, "Orderbook missing, retrying");
        await sleep(750);
        continue;
      }

      if (!status || status >= 500 || status === 429) {
        logger.warn({ tokenId, status }, "CLOB preflight failed, retrying");
        await sleep(1000);
        continue;
      }

      throw error;
    }
  }
};

export const placeOrder = async ({ client, tokenId, price, size, side }) => {
  const orderPayload = {
    tokenID: tokenId,
    price: Number(price),
    size: Number(size),
    side,
  };

  const order = await client.createOrder(orderPayload);
  const result = await client.postOrder(order);
  return result;
};
