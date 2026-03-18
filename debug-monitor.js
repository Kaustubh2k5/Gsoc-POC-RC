/**
 * Debug Monitor
 * =============
 * Wraps the MCP tools with full observability:
 *   - Every tool call logged with input
 *   - Output token count (estimated)
 *   - Timing per tool
 *   - Cache hit/miss (tree-sitter vs regex-fallback)
 *   - Running session totals
 *   - Graph stats: parsed vs frontier
 *   - End-of-session report saved to /tmp/analyzer-session-*.json + *.txt
 *
 * Usage (instead of running index.js directly):
 *   node debug-monitor.js
 *
 * Output goes to stderr so it doesn't interfere with MCP stdio protocol.
 * Watch it in a second terminal:
 *   tail -f /tmp/analyzer-debug.log
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolve } from 'path';
import { appendFileSync, writeFileSync } from 'fs';

import { SessionReporter } from './hooks/session-report.js';
import { GraphStore }       from './src/index/graph-store.js';
import { skeletonizeFile, extractSymbol } from './src/ts-engine/index.js';
import { buildAliasMap }    from './src/utils/alias.js';

// =============================================================================
// Debug logger — writes to stderr AND a log file
// =============================================================================

const LOG_FILE = '/tmp/analyzer-debug.log';

try {
  writeFileSync(LOG_FILE, `\n${'═'.repeat(70)}\nSession started: ${new Date().toISOString()}\n${'═'.repeat(70)}\n`);
} catch {}

function log(line) {
  const out = line + '\n';
  process.stderr.write(out);
  try { appendFileSync(LOG_FILE, out); } catch {}
}

function estimateTokens(text) {
  return Math.ceil(String(text).length / 4);
}

// =============================================================================
// Session reporter — replaces the old session object + recordCall + printSummary
// =============================================================================

const reporter = new SessionReporter();

setInterval(() => reporter.print(), 30_000).unref();
process.on('exit',   () => reporter.print());
process.on('SIGINT', () => { reporter.print(); process.exit(0); });

// =============================================================================
// Instrumented tool wrapper
// =============================================================================

function instrument(toolName, fn) {
  return async (args) => {
    const inputTokens = estimateTokens(JSON.stringify(args));
    const t0 = Date.now();

    log('');
    log(`▶ TOOL: ${toolName}`);
    log(`  Input:  ${JSON.stringify(args).slice(0, 200)}`);
    log(`  Tokens in: ~${inputTokens}`);

    let result, extra = {};
    try {
      result = await fn(args, (info) => { extra = { ...extra, ...info }; });
    } catch (err) {
      const ms = Date.now() - t0;
      log(`  ❌ ERROR: ${err.message}`);
      reporter.record({
        tool: toolName, inputTokens, outputTokens: 0,
        ms, engine: null, fromCache: false, error: err.message,
      });
      throw err;
    }

    const ms           = Date.now() - t0;
    const outputText   = result?.content?.[0]?.text ?? '';
    const outputTokens = estimateTokens(outputText);

    reporter.record({
      tool:      toolName,
      inputTokens,
      outputTokens,
      ms,
      engine:    extra.engine   ?? null,
      fromCache: extra.fromCache ?? false,
      error:     null,
    });

    log(`  Output: ~${outputTokens} tokens  |  ${ms}ms${extra.engine ? `  |  engine: ${extra.engine}` : ''}${extra.fromCache ? '  |  CACHE HIT' : ''}`);

    const preview = outputText.split('\n').slice(0, 8).join('\n');
    log(`  Preview:\n${preview.split('\n').map(l => '    ' + l).join('\n')}`);

    return result;
  };
}

// =============================================================================
// Setup
// =============================================================================

const REPO_ROOT = process.env.REPO_ROOT ? resolve(process.env.REPO_ROOT) : process.cwd();

log(`\n🔍 Debug Monitor — REPO_ROOT: ${REPO_ROOT}`);
log(`📋 Log file: ${LOG_FILE}`);
log(`   Watch with: tail -f ${LOG_FILE}\n`);

const store = new GraphStore(REPO_ROOT);
reporter.attachGraph(store);   // lets the report include graph stats

let _aliasMap = null;
async function getAliasMap() {
  if (!_aliasMap) _aliasMap = await buildAliasMap(REPO_ROOT);
  return _aliasMap;
}

log('⏳ Discovering files...');
const t0 = Date.now();
store.ensureReady().then(() => {
  const stats = store.getStats();
  const ms    = Date.now() - t0;
  log(`✅ Ready in ${ms}ms — ${stats.totalFiles.toLocaleString()} files discovered, 0 parsed (lazy)`);
}).catch(e => log(`❌ Ready failed: ${e.message}`));

const text = str => ({ content: [{ type: 'text', text: String(str) }] });

function groupByDir(files, depth = 3) {
  const groups = {};
  for (const item of files) {
    const f = typeof item === 'string' ? item : (item.file ?? item.nodeId ?? String(item));
    const parts = f.split('/');
    const dir   = parts.slice(0, depth).join('/');
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  }
  return groups;
}

// =============================================================================
// MCP Server
// =============================================================================

const server = new McpServer({ name: 'rocketchat-code-analyzer-debug', version: '3.0.0' });

// ── Tool 1: list_files ────────────────────────────────────────────────────────
server.registerTool('list_files', {
  description: 'Lists files in the repository for initial discovery.',
  inputSchema: z.object({
    path:        z.string().optional(),
    pattern:     z.string().optional(),
    max_results: z.number().int().min(1).max(500).default(100).optional(),
  }).shape,
},
instrument('list_files', async ({ path: subPath, pattern, max_results = 100 }) => {
  await store.ensureReady();
  const prefix = subPath ? subPath.replace(/^\//, '') : '';
  let files    = prefix ? store.allFiles.filter(f => f.startsWith(prefix)) : store.allFiles;
  if (pattern) files = files.filter(f => f.includes(pattern));
  const capped = files.slice(0, max_results);

  const lines = [
    `📁 Repo: ${REPO_ROOT}`,
    `📂 Scope: ${subPath ?? '/'}  |  📄 ${capped.length} files${capped.length < files.length ? ` (capped — ${files.length} total)` : ''}`,
    '',
    ...capped.map(f => `  ${f}`),
    '',
    '💡 Next: call read_file_skeleton with a specific file path.',
  ];
  return text(lines.join('\n'));
}));

// ── Tool 2: read_file_skeleton ────────────────────────────────────────────────
server.registerTool('read_file_skeleton', {
  description: 'Returns an ultra-lean structural skeleton of a file. 90-97% token reduction.',
  inputSchema: z.object({
    file_path:              z.string(),
    include_imports:        z.boolean().default(true).optional(),
    include_meteor_methods: z.boolean().default(true).optional(),
  }).shape,
},
instrument('read_file_skeleton', async ({ file_path, include_imports = true, include_meteor_methods = true }, report) => {
  await store.ensureFile(file_path);

  const result = await skeletonizeFile(file_path, REPO_ROOT);
  if (result.error) return text(`❌ ${result.error}`);

  report({
    engine:        result.stats?.engine,
    originalLines: result.stats?.originalLines,
    skeletonLines: result.stats?.skeletonLines,
    reductionPct:  result.stats?.reductionPct,
  });

  let skeleton = result.skeleton;
  if (!include_imports) {
    skeleton = skeleton.split('\n').filter(l => !l.trimStart().startsWith('import ')).join('\n');
  }

  const gStats = store.getStats();
  const lines = [
    `📄 ${file_path}`,
    `📊 ${result.stats?.skeletonLines} skeleton lines (was ${result.stats?.originalLines} — ${result.stats?.reductionPct}% reduction) | engine: ${result.stats?.engine}`,
    `🗺️  Graph: ${gStats.parsedFiles}/${gStats.totalFiles} files parsed | ${gStats.totalSymbols} nodes | frontier: ${gStats.frontierFiles}`,
    '',
    '```typescript',
    skeleton || '(no exported symbols found)',
    '```',
  ];

  if (include_meteor_methods && result.meteorMethods?.length > 0) {
    lines.push('', '🌐 Meteor Methods:', ...result.meteorMethods.map(m => `  - '${m}'`));
  }

  lines.push('', '💡 Next: call read_symbol_details with a specific symbol name.');
  return text(lines.join('\n'));
}));

// ── Tool 3: read_symbol_details ───────────────────────────────────────────────
server.registerTool('read_symbol_details', {
  description: 'Returns the full source of a named symbol. AST-based extraction.',
  inputSchema: z.object({
    file_path:   z.string(),
    symbol_name: z.string(),
  }).shape,
},
instrument('read_symbol_details', async ({ file_path, symbol_name }, report) => {
  await store.ensureFile(file_path);

  const result = await extractSymbol(file_path, symbol_name, REPO_ROOT);

  report({ engine: result.engine });

  if (result.error || !result.source) {
    const candidates = store.lookupSymbol(symbol_name);
    return text([
      `❌ Symbol '${symbol_name}' not found in ${file_path}`,
      '',
      candidates.length > 0 ? '💡 Found in:' : '💡 Try search_symbol.',
      ...candidates.map(c => `  ${c.file}:${c.line}`),
    ].join('\n'));
  }

  const nodeId   = `${file_path}::${symbol_name}`;
  const node     = store.nodes.get(nodeId);
  const callInfo = node
    ? `\n🔗 Calls: ${node.calls.length} | Called by: ${node.calledBy.length}`
    : '';

  const lineCount = result.source.split('\n').length;
  return text([
    `📄 ${file_path} → ${symbol_name}  (L${result.lineStart}–${result.lineEnd}, ${lineCount} lines)${callInfo}`,
    '',
    '```typescript',
    result.source,
    '```',
  ].join('\n'));
}));

// ── Tool 4: search_symbol ─────────────────────────────────────────────────────
server.registerTool('search_symbol', {
  description: 'Content-aware symbol search across the entire repo.',
  inputSchema: z.object({
    query:        z.string(),
    file_pattern: z.string().optional(),
    max_results:  z.number().int().min(1).max(50).default(15).optional(),
  }).shape,
},
instrument('search_symbol', async ({ query, file_pattern, max_results = 15 }) => {
  await store.ensureReady();
  const results = await store.querySymbol(query, { filePattern: file_pattern, maxResults: max_results });

  if (results.length === 0) return text(`🔍 No results for "${query}"`);

  const lines = [
    `🔍 "${query}" — ${results.length} result(s):`,
    '',
    ...results.map((r, i) =>
      `  ${i+1}. [score:${r.score}] ${r.file}\n     Symbols: ${r.symbols.slice(0,5).map(s => s.name).join(', ') || '(none)'}\n     Reason: ${r.reason}`
    ),
  ];
  return text(lines.join('\n'));
}));

// ── Tool 5: resolve_meteor_method ─────────────────────────────────────────────
server.registerTool('resolve_meteor_method', {
  description: 'Resolves a Meteor method name to its implementation file.',
  inputSchema: z.object({ method_name: z.string() }).shape,
},
instrument('resolve_meteor_method', async ({ method_name }) => {
  await store.ensureReady();
  const methods = store.getMeteorMethods();
  if (methods[method_name]) return text(`✅ '${method_name}' → ${methods[method_name]}`);

  const fuzzy = Object.entries(methods)
    .filter(([k]) => k.includes(method_name) || method_name.includes(k))
    .slice(0, 5);

  if (fuzzy.length > 0) return text([`⚠️ Similar:`, ...fuzzy.map(([k,v]) => `  '${k}' → ${v}`)].join('\n'));
  return text(`❌ '${method_name}' not found.`);
}));

// ── Tool 6: resolve_alias ─────────────────────────────────────────────────────
server.registerTool('resolve_alias', {
  description: 'Resolves a TypeScript path alias to its real filesystem path.',
  inputSchema: z.object({ alias: z.string() }).shape,
},
instrument('resolve_alias', async ({ alias }) => {
  const aliasMap = await getAliasMap();
  if (aliasMap[alias]) return text(`✅ ${alias} → ${aliasMap[alias]}`);

  const base = alias.replace(/\/.*$/, '');
  if (aliasMap[base]) return text(`✅ ${alias} → ${aliasMap[base]}${alias.slice(base.length)}`);

  const candidates = Object.entries(aliasMap)
    .filter(([k]) => alias.includes(k) || k.includes(alias.replace('@','')))
    .slice(0, 5);

  if (candidates.length > 0) return text([`⚠️ Related:`, ...candidates.map(([k,v]) => `  ${k} → ${v}`)].join('\n'));
  return text(`❌ '${alias}' not in tsconfig. Available: ${Object.keys(aliasMap).slice(0,8).join(', ')}`);
}));

// ── Tool 7: blast_radius ──────────────────────────────────────────────────────
server.registerTool('blast_radius', {
  description: [
    'Shows what is affected by changing a file or a specific function.',
    'With symbol_name: function-level — finds callers of that exact function (precise).',
    'Without symbol_name: file-level — finds files that import this file (broad).',
  ].join(' '),
  inputSchema: z.object({
    file_path:   z.string(),
    symbol_name: z.string().optional().describe('If provided, gives function-level blast radius'),
    max_depth:   z.number().int().min(1).max(6).default(4).optional(),
  }).shape,
},
instrument('blast_radius', async ({ file_path, symbol_name, max_depth = 4 }) => {
  await store.ensureFile(file_path);

  let affected, mode;

  if (symbol_name) {
    const nodeId = `${file_path}::${symbol_name}`;
    const node   = store.nodes.get(nodeId);

    if (!node) {
      return text([
        `❌ Symbol '${symbol_name}' not found in parsed graph for ${file_path}.`,
        `💡 Try read_file_skeleton('${file_path}') first to parse it, then retry.`,
      ].join('\n'));
    }

    affected = store.computeBlastRadius(nodeId, max_depth);
    mode = `function-level: callers of ${symbol_name}()`;
  } else {
    affected = store.computeBlastRadius(file_path, max_depth);
    mode = 'file-level: files that import this file';
  }

  if (affected.length === 0) {
    return text(`✅ No affected callers found for ${symbol_name ?? file_path} — safe to modify.`);
  }

  const isFnLevel = !!symbol_name;
  const groups    = isFnLevel
    ? groupByDir(affected.map(a => a.nodeId.split('::')[0]))
    : groupByDir(affected);

  const lines = [
    `⚠️ Blast radius [${mode}]`,
    `   ${affected.length} affected, depth ≤ ${max_depth}`,
    '',
    ...Object.entries(groups).flatMap(([dir, files]) => [
      `  📁 ${dir}/ (${files.length})`,
      ...files.map(f => `     - ${f}`),
    ]),
  ];

  if (isFnLevel) {
    lines.push('', '💡 Use blast_radius without symbol_name for a broader file-level view.');
  }

  return text(lines.join('\n'));
}));

// ── Tool 8: repo_stats ────────────────────────────────────────────────────────
server.registerTool('repo_stats', {
  description: 'Overview: file count, symbol nodes, graph edges, parse progress, session token usage.',
  inputSchema: z.object({}).shape,
},
instrument('repo_stats', async () => {
  await store.ensureReady();
  const stats    = store.getStats();
  const aliasMap = await getAliasMap();
  const report   = reporter.buildReport();
  const pct      = stats.totalFiles > 0
    ? ((stats.parsedFiles / stats.totalFiles) * 100).toFixed(1)
    : '0.0';

  const fallbackOps = report.rawCalls
    ?.filter(c => c.engine === 'regex-fallback' || c.engine === 'token-stream-fallback')
    .length ?? 0;

  const lines = [
    '📊 Rocket.Chat Code Analyzer v3 — Dynamic Graph',
    '─'.repeat(50),
    `🏠 Repo:               ${REPO_ROOT}`,
    `📁 Total files:        ${stats.totalFiles.toLocaleString()}`,
    `✅ Parsed:             ${stats.parsedFiles.toLocaleString()} (${pct}%)`,
    `🗺️  Frontier:          ${stats.frontierFiles.toLocaleString()} (known, unparsed)`,
    `🔤 Function nodes:     ${stats.totalSymbols.toLocaleString()}`,
    `🌐 Meteor methods:     ${stats.meteorMethods}`,
    `🔗 tsconfig aliases:   ${Object.keys(aliasMap).length}`,
    `📈 Import graph edges: ${stats.graphEdges.toLocaleString()}`,
    '',
    '💰 Session token usage:',
    `   Total tool calls:   ${report.summary.totalToolCalls}`,
    `   Tokens in:          ~${report.summary.totalTokensIn.toLocaleString()}`,
    `   Tokens out:         ~${report.summary.totalTokensOut.toLocaleString()}`,
    `   Tokens / call:      ~${report.efficiency.tokensPerCall}`,
    `   Session elapsed:    ${report.meta.elapsedSec}s`,
    '',
    '🔧 Engine stats:',
    `   AST (tree-sitter):  ${report.summary.totalToolCalls - fallbackOps} ops`,
    `   Fallback used:      ${fallbackOps} ops`,
    `   Cache hit rate:     ${report.efficiency.cacheHitRate}`,
    '',
    '📋 Tools used this session:',
    ...(report.perTool ?? []).map(t =>
      `   ${t.tool.padEnd(28)} ${t.calls}x  ~${t.tokensOut}t out  avg ${t.avgMs}ms`
    ),
    '',
    '💡 Graph grows as you explore — heavily used areas get densely connected.',
    `💡 Full report: ${reporter.txtPath}`,
  ];

  return text(lines.join('\n'));
}));

// ── Tool 9: reindex ───────────────────────────────────────────────────────────
server.registerTool('reindex', {
  description: 'Clears the graph and re-discovers all files. Parsed nodes are reset.',
  inputSchema: z.object({}).shape,
},
instrument('reindex', async () => {
  const t0 = Date.now();
  await store.reindex();
  const stats = store.getStats();
  const ms    = Date.now() - t0;

  return text([
    '✅ Reindex complete!',
    '─'.repeat(50),
    `⏱️ Time taken:        ${ms}ms`,
    `📁 Files discovered:  ${stats.totalFiles.toLocaleString()}`,
    `🗺️  All files reset to frontier (lazy parse on next access)`,
  ].join('\n'));
}));

// ── Tool 10: get_scope ────────────────────────────────────────────────────────
server.registerTool('get_scope', {
  description:
    'CALL THIS FIRST for any task. Returns scoped skeletons of only relevant ' +
    'files based on dependency graph traversal. Parses seed files on demand.',
  inputSchema: z.object({
    symbols:    z.array(z.string()).describe('Symbol names or file paths for the task'),
    max_tokens: z.number().int().default(8000).optional(),
    max_depth:  z.number().int().min(1).max(3).default(2).optional(),
    max_files:  z.number().int().min(1).max(60).default(40).optional(),
  }).shape,
},
instrument('get_scope', async ({ symbols, max_tokens = 8000, max_depth = 2, max_files = 40 }, report) => {
  await store.ensureReady();

  for (const sym of symbols) {
    if (sym.match(/\.(ts|tsx|js|jsx)$/)) {
      await store.ensureFile(sym);
    } else {
      const locs = store.lookupSymbol(sym);
      for (const loc of locs) await store.ensureFile(loc.file);
      if (store.meteorMethods[sym]) await store.ensureFile(store.meteorMethods[sym]);
    }
  }

  const scopeEntries = store.computeScope(symbols, { maxDepth: max_depth, maxFiles: max_files });

  if (scopeEntries.length === 0) {
    return text([
      `❌ No files found for: ${symbols.join(', ')}`,
      `💡 Try search_symbol("${symbols[0]}") first.`,
    ].join('\n'));
  }

  const sections      = [];
  let totalTokens     = 0;
  let skipped         = 0;
  const skippedFiles  = [];

  for (const entry of scopeEntries) {
    await store.ensureFile(entry.file);

    const result = await skeletonizeFile(entry.file, REPO_ROOT);
    if (result.error) continue;

    const tokenEst = estimateTokens(result.skeleton);
    if (totalTokens + tokenEst > max_tokens) {
      skipped++;
      skippedFiles.push(`${entry.file} (~${tokenEst}t)`);
      continue;
    }
    totalTokens += tokenEst;

    const label = entry.depth === 0 ? '🎯 SEED' : `↳ depth-${entry.depth}`;
    sections.push([
      `── ${entry.file}  [${label} | score:${entry.score} | ${entry.reason}]  (~${tokenEst}t)`,
      result.skeleton,
    ].join('\n'));
  }

  const gStats = store.getStats();
  report({ engine: 'scope' });

  return text([
    `🎯 SCOPE: ${scopeEntries.length} files found, ${sections.length} loaded, ${skipped} skipped`,
    `   symbols: ${symbols.join(', ')}`,
    `   tokens:  ~${totalTokens} / ${max_tokens} used`,
    `   graph:   ${gStats.parsedFiles}/${gStats.totalFiles} files parsed | ${gStats.totalSymbols} nodes`,
    skippedFiles.length > 0 ? `   skipped: ${skippedFiles.join(', ')}` : `   ✅ all within budget`,
    `${'─'.repeat(50)}`,
    '',
    ...sections,
    '',
    `${'─'.repeat(50)}`,
    `💡 read_symbol_details(file, name) to drill into a body`,
    `💡 blast_radius(file, symbol_name) for function-level impact`,
  ].join('\n'));
}));

// =============================================================================
// Start
// =============================================================================
const transport = new StdioServerTransport();
await server.connect(transport);