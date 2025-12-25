import fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./log.js";

const defaultState = { tradedSlugs: {} };

const ensureDir = async (filePath) => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
};

export const loadState = async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { ...defaultState, ...JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { ...defaultState };
    }
    logger.warn({ err: error }, "Failed to load state, starting fresh");
    return { ...defaultState };
  }
};

export const saveState = async (filePath, state) => {
  await ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  const payload = JSON.stringify(state, null, 2);
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, filePath);
};
