import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Set or replace KEY=value in .env, keeping every other line. */
export function setEnvVar(root: string, key: string, value: string): void {
  const file = path.join(root, ".env");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
  process.env[key] = value;
}
