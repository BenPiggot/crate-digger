import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./core/mcp/mcp.js";

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("crate-digger MCP server running on stdio");
