import { readFileSync } from "node:fs";
import { parseMandateFile, type LoadedMandate } from "./mandate";

/** Node-only helpers (kept out of the browser entry point). */
export function loadMandateFile(path: string): LoadedMandate {
  return parseMandateFile(JSON.parse(readFileSync(path, "utf8")));
}

export { custosVaultBytecode } from "./vault-bytecode";
