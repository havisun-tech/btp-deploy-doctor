#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';

async function main() {
  const root = process.argv[2];
  const server = createServer({ defaultRoot: root });
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; log to stderr only.
  console.error(`btp-deploy-doctor MCP server running on stdio (project: ${root ?? process.cwd()})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
