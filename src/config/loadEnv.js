import { readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

/**
 * Minimal zero-dependency .env loader for CLI entry points.
 * Existing process.env values always win, so explicit overrides and test
 * setups are never clobbered. Intended to be called once at startup.
 */
export function loadEnv({ cwd = process.cwd(), file = ".env", force = false } = {}) {
  if (loaded && !force) {
    return process.env;
  }
  loaded = true;

  const envPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);

  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return process.env;
    }
    throw error;
  }

  for (const entry of parseEnv(raw)) {
    if (process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
    }
  }

  return process.env;
}

export function parseEnv(raw) {
  const entries = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const eq = trimmed.indexOf("=");
    if (eq === -1) {
      continue;
    }

    const key = trimmed.slice(0, eq).trim();
    if (!key) {
      continue;
    }

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value });
  }

  return entries;
}
