import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.js";
/** Local authenticated proxy for Codex plugins and Secure MCP Tunnel stdio profiles. */
export async function serveStdio(c: Config) {
  const client = new Client({ name: "codexbridge-stdio", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${c.port}/mcp`),
      { requestInit: { headers: { Authorization: `Bearer ${c.token}` } } },
    ),
  );
  const server = new Server(
    { name: "codexbridge", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    client.listTools(),
  );
  server.setRequestHandler(CallToolRequestSchema, async (r) =>
    client.callTool(r.params),
  );
  await server.connect(new StdioServerTransport());
  process.stdin.once("end", () => {
    void client.close();
    void server.close();
  });
}
