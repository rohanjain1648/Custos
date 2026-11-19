import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface LoadedInvoice {
  file: string;
  text: string;
  /** sha256 of the content, so an edited file is processed again. */
  digest: string;
}

const EXTENSIONS = new Set([".md", ".txt", ".markdown"]);

export function loadInvoices(dir: string): LoadedInvoice[] {
  return readdirSync(dir)
    .filter((f) => EXTENSIONS.has(path.extname(f).toLowerCase()) && f.toLowerCase() !== "readme.md")
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(dir, file), "utf8");
      return { file, text, digest: createHash("sha256").update(text).digest("hex") };
    });
}
