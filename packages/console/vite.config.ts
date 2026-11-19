import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Reads the repository's .env so the console finds the local Keeper without extra setup.
// The Keeper API token is injected only for the dev server (`npm run console`), never into a production build.
// strictPort: the owner signer trusts exactly this origin, so the console must not drift to another port.
export default defineConfig(({ command, mode }) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const env = loadEnv(mode, root, "");
  const keeperPort = env.KEEPER_PORT || "8787";
  return {
    plugins: [react()],
    define: {
      __KEEPER_URL__: JSON.stringify(env.KEEPER_URL || `http://127.0.0.1:${keeperPort}`),
      __KEEPER_TOKEN__: JSON.stringify(command === "serve" ? env.KEEPER_API_TOKEN || "" : ""),
      __OWNER_SIGNER_URL__: JSON.stringify(`http://127.0.0.1:${env.OWNER_SIGNER_PORT || "8788"}`),
    },
    server: { host: "127.0.0.1", port: Number(env.CONSOLE_PORT || 5173), strictPort: true },
  };
});
