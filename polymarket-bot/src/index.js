import { config } from "./config.js";
import { logger } from "./log.js";
import { loadState, saveState } from "./state.js";
import { waitForTradable, pickTokenIdForOutcome } from "./gamma.js";
import { createClient, preflightOrderBook, placeOrder } from "./clob.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const run = async () => {
  logger.info({ config: { ...config, pk: "<redacted>" } }, "Bot starting");
  const state = await loadState(config.stateFile);
  const client = createClient();

  while (true) {
    try {
      const { event, market } = await waitForTradable({
        pollMs: config.pollMs,
        maxWaitMs: config.maxWaitMs,
      });

      if (state.tradedSlugs[event.slug]) {
        logger.info({ slug: event.slug }, "Event already traded, waiting");
        await sleep(config.pollMs);
        continue;
      }

      const tokenId = pickTokenIdForOutcome(market, config.desiredOutcome);
      logger.info(
        { slug: event.slug, tokenId, outcome: config.desiredOutcome },
        "Selected market token"
      );

      await preflightOrderBook(client, tokenId);
      const orderResult = await placeOrder({
        client,
        tokenId,
        price: config.price,
        size: config.size,
        side: config.side,
      });

      state.tradedSlugs[event.slug] = {
        tokenId,
        orderId: orderResult?.id || orderResult?.orderID || null,
        at: new Date().toISOString(),
      };
      await saveState(config.stateFile, state);
      logger.info(
        { slug: event.slug, order: orderResult },
        "Order placed and state saved"
      );
    } catch (error) {
      logger.error({ err: error }, "Unexpected error in main loop");
      await sleep(config.pollMs);
    }
  }
};

run().catch((error) => {
  logger.error({ err: error }, "Fatal startup error");
  process.exit(1);
});
