import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";

/** Read-only QoreChain MCP tools the Brain may use. The server itself never signs or broadcasts. */
const ALLOWED = new Set(["get_address_info", "get_pq_status", "get_chain_info", "read_contract"]);

export interface McpBridge {
  tools: unknown[];
  names: string[];
  close(): Promise<void>;
}

/**
 * Start QoreChain's official MCP server (`@qorechain/mcp`, stdio, no API key) and expose a read-only subset of
 * its tools to Claude as `qorechain_<name>`. Returns null when the server cannot start; the Brain works without it.
 */
export async function connectQorechainMcp(log: (s: string) => void = () => undefined): Promise<McpBridge | null> {
  try {
    const require = createRequire(import.meta.url);
    const bin = path.join(path.dirname(require.resolve("@qorechain/mcp/package.json")), "dist", "bin.js");
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin], stderr: "ignore" });
    const client = new Client({ name: "custos-brain", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const picked = listed.tools.filter((t) => ALLOWED.has(t.name));
    const tools = picked.map((t) =>
      betaTool({
        name: `qorechain_${t.name}`,
        description: `${t.description ?? t.name} (QoreChain testnet, read-only)`,
        inputSchema: t.inputSchema as any,
        run: async (input: any) => {
          const result = await client.callTool({ name: t.name, arguments: { network: "testnet", ...(input ?? {}) } });
          return JSON.stringify(result.content).slice(0, 8000);
        },
      } as any),
    );
    log(`[brain] QoreChain MCP server connected: ${picked.map((t) => t.name).join(", ")}`);
    return { tools, names: picked.map((t) => t.name), close: () => client.close() };
  } catch (e) {
    log(`[brain] QoreChain MCP server not available (${(e as Error).message}); continuing without chain tools`);
    return null;
  }
}
