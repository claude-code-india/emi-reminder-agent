import { existsSync, readFileSync } from "node:fs";

/** Minimal .env loader (no dependencies). Never overrides variables already set in the environment. */
export function loadEnv(file = ".env"): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
