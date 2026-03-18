/**
 * Rocket.Chat Code Analyzer — MCP Server Entry Point
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'path';

import { GraphStore } from './src/index/graph-store.js';
import { skeletonizeFile, extractSymbol } from './src/ts-engine/index.js';
import { buildAliasMap } from './src/utils/alias.js';

const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();
const store = new GraphStore(REPO_ROOT);
let _aliasMap = null;

async function getAliasMap() {
  if (!_aliasMap) _aliasMap = await buildAliasMap(REPO_ROOT);
  return _aliasMap;
}

const text = str => ({ content: [{ type: 'text', text: String(str) }] });

const server = new McpServer({ name: 'rocketchat-code-analyzer', version: '3.0.0' });

server.registerTool('list_files', {
  description: 'Lists files in the repository.',
  inputSchema: z.object({
    path:        z.string().optional(),
    pattern:     z.string().optional(),
    max_results: z.number().int().default(100).optional(),
  }).shape,
}, async ({ path: subPath, pattern, max_results = 100 }) => {
  await store.ensureReady();
  const prefix = subPath ? subPath.replace(/^\//, '') : '';
  let files = prefix ? store.allFiles.filter(f => f.startsWith(prefix)) : store.allFiles;
  if (pattern) files = files.filter(f => f.includes(pattern));
  const capped = files.slice(0, max_results);
  return text([`📁 Repo: ${REPO_ROOT}`, ...capped].join('\n'));
});

server.registerTool('read_file_skeleton', {
  description: 'Returns a structural skeleton of a file.',
  inputSchema: z.object({ file_path: z.string() }).shape,
}, async ({ file_path }) => {
  await store.ensureFile(file_path);
  const result = await skeletonizeFile(file_path, REPO_ROOT);
  if (result.error) return text(`❌ ${result.error}`);
  return text(`📄 ${file_path}\n\n\`\`\`typescript\n${result.skeleton}\n\`\`\``);
});

server.registerTool('read_symbol_details', {
  description: 'Returns the full source of a named symbol.',
  inputSchema: z.object({ file_path: z.string(), symbol_name: z.string() }).shape,
}, async ({ file_path, symbol_name }) => {
  await store.ensureFile(file_path);
  const result = await extractSymbol(file_path, symbol_name, REPO_ROOT);
  if (result.error || !result.source) return text(`❌ Symbol not found.`);
  return text(`📄 ${file_path} → ${symbol_name}\n\n\`\`\`typescript\n${result.source}\n\`\`\``);
});

const transport = new StdioServerTransport();
await server.connect(transport);