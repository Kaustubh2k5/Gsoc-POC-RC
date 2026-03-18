/**
 * session-report.js
 * =================
 * Plugs into debug-monitor.js to produce a full end-of-session report.
 *
 * Usage: import { SessionReporter } from './hooks/session-report.js'
 * Then replace the existing session/printSessionSummary code in debug-monitor.js
 * with a SessionReporter instance (see integration note at bottom).
 *
 * Output goes to:
 *   stderr     — always (visible in terminal)
 *   /tmp/analyzer-session-YYYY-MM-DD-HHmm.json  — machine-readable
 *   /tmp/analyzer-session-YYYY-MM-DD-HHmm.txt   — human-readable
 */

import { writeFileSync } from 'fs';

export class SessionReporter {
  constructor() {
    this.startTime    = Date.now();
    this.toolCalls    = [];        // full ordered list of every call
    this.toolStats    = {};        // per-tool aggregates
    this.cacheHits    = 0;
    this.cacheMisses  = 0;
    this._graphRef    = null;      // set via attachGraph(store)

    // Timestamp for filenames
    const d = new Date();
    const ts = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
    this.jsonPath = `/tmp/analyzer-session-${ts}.json`;
    this.txtPath  = `/tmp/analyzer-session-${ts}.txt`;

    function p(n) { return String(n).padStart(2, '0'); }
  }

  /** Call once after GraphStore is created so the report can read graph stats. */
  attachGraph(store) {
    this._graphRef = store;
  }

  /**
   * Record one tool call. Call this from inside instrument() after the result
   * comes back.
   *
   *   reporter.record({
   *     tool, inputTokens, outputTokens, ms,
   *     engine,        // 'tree-sitter' | 'regex-fallback' | ...
   *     fromCache,     // bool
   *     error,         // string | null
   *   });
   */
  record({ tool, inputTokens, outputTokens, ms, engine, fromCache, error }) {
    const entry = {
      seq:          this.toolCalls.length + 1,
      tool,
      inputTokens,
      outputTokens,
      ms,
      engine:       engine ?? null,
      fromCache:    fromCache ?? false,
      error:        error ?? null,
      wallTime:     new Date().toISOString(),
    };
    this.toolCalls.push(entry);

    // Aggregates
    if (!this.toolStats[tool]) {
      this.toolStats[tool] = { calls: 0, tokensIn: 0, tokensOut: 0, totalMs: 0, errors: 0 };
    }
    const s = this.toolStats[tool];
    s.calls++;
    s.tokensIn  += inputTokens;
    s.tokensOut += outputTokens;
    s.totalMs   += ms;
    if (error) s.errors++;

    if (engine === 'tree-sitter')    this.cacheHits++;
    if (engine === 'regex-fallback' ||
        engine === 'token-stream-fallback') this.cacheMisses++;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Build the full report object
  // ──────────────────────────────────────────────────────────────────────────

  buildReport() {
    const elapsedMs  = Date.now() - this.startTime;
    const graphStats = this._graphRef?.getStats() ?? null;

    const totalTokensIn  = this.toolCalls.reduce((s, c) => s + c.inputTokens,  0);
    const totalTokensOut = this.toolCalls.reduce((s, c) => s + c.outputTokens, 0);
    const totalErrors    = this.toolCalls.filter(c => c.error).length;

    // Tool call sequence — compact list
    const callSequence = this.toolCalls.map(c =>
      `${c.seq}. ${c.tool} (${c.ms}ms, ~${c.outputTokens}t out${c.engine ? `, ${c.engine}` : ''}${c.error ? ', ERR' : ''})`
    );

    // Per-tool breakdown sorted by total tokens out desc
    const perTool = Object.entries(this.toolStats)
      .map(([tool, s]) => ({
        tool,
        calls:       s.calls,
        tokensIn:    s.tokensIn,
        tokensOut:   s.tokensOut,
        avgMs:       Math.round(s.totalMs / s.calls),
        errors:      s.errors,
      }))
      .sort((a, b) => b.tokensOut - a.tokensOut);

    // Efficiency metrics
    const efficiency = {
      tokensPerCall:      totalTokensOut > 0
        ? Math.round(totalTokensOut / this.toolCalls.length)
        : 0,
      parsedFilePct:      graphStats
        ? ((graphStats.parsedFiles / graphStats.totalFiles) * 100).toFixed(1) + '%'
        : 'n/a',
      cacheHitRate:       (this.cacheHits + this.cacheMisses) > 0
        ? ((this.cacheHits / (this.cacheHits + this.cacheMisses)) * 100).toFixed(1) + '%'
        : 'n/a',
      frontierPct:        graphStats
        ? ((graphStats.frontierFiles / graphStats.totalFiles) * 100).toFixed(1) + '%'
        : 'n/a',
    };

    return {
      meta: {
        startTime:  new Date(this.startTime).toISOString(),
        endTime:    new Date().toISOString(),
        elapsedMs,
        elapsedSec: (elapsedMs / 1000).toFixed(1),
      },
      summary: {
        totalToolCalls:  this.toolCalls.length,
        totalTokensIn,
        totalTokensOut,
        totalErrors,
        uniqueTools:     Object.keys(this.toolStats).length,
      },
      efficiency,
      graph:   graphStats,
      perTool,
      callSequence,
      rawCalls: this.toolCalls,
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Human-readable text report
  // ──────────────────────────────────────────────────────────────────────────

  buildTextReport(report) {
    const { meta, summary, efficiency, graph, perTool, callSequence } = report;
    const lines = [];
    const hr = '═'.repeat(64);
    const hr2 = '─'.repeat(64);

    lines.push(hr);
    lines.push('  SESSION REPORT — Rocket.Chat Code Analyzer');
    lines.push(hr);
    lines.push(`  Started:  ${meta.startTime}`);
    lines.push(`  Ended:    ${meta.endTime}`);
    lines.push(`  Elapsed:  ${meta.elapsedSec}s`);
    lines.push('');

    lines.push('  SUMMARY');
    lines.push(hr2);
    lines.push(`  Tool calls:      ${summary.totalToolCalls}`);
    lines.push(`  Unique tools:    ${summary.uniqueTools}`);
    lines.push(`  Tokens in:       ~${summary.totalTokensIn.toLocaleString()}`);
    lines.push(`  Tokens out:      ~${summary.totalTokensOut.toLocaleString()}`);
    lines.push(`  Errors:          ${summary.totalErrors}`);
    lines.push('');

    lines.push('  EFFICIENCY');
    lines.push(hr2);
    lines.push(`  Tokens / call:   ${efficiency.tokensPerCall}`);
    lines.push(`  AST cache hits:  ${efficiency.cacheHitRate}`);
    lines.push(`  Files parsed:    ${graph ? `${graph.parsedFiles}/${graph.totalFiles} (${efficiency.parsedFilePct})` : 'n/a'}`);
    lines.push(`  Frontier left:   ${graph ? `${graph.frontierFiles} files (${efficiency.frontierPct} untouched)` : 'n/a'}`);
    lines.push(`  Function nodes:  ${graph?.totalSymbols ?? 'n/a'}`);
    lines.push(`  Graph edges:     ${graph?.graphEdges ?? 'n/a'}`);
    lines.push('');

    lines.push('  PER-TOOL BREAKDOWN');
    lines.push(hr2);
    const colW = [24, 6, 10, 10, 8, 6];
    lines.push(
      '  ' +
      'Tool'.padEnd(colW[0]) +
      'Calls'.padStart(colW[1]) +
      'Tok-in'.padStart(colW[2]) +
      'Tok-out'.padStart(colW[3]) +
      'Avg-ms'.padStart(colW[4]) +
      'Errs'.padStart(colW[5])
    );
    lines.push('  ' + '·'.repeat(colW.reduce((a,b) => a+b, 0)));
    for (const t of perTool) {
      lines.push(
        '  ' +
        t.tool.padEnd(colW[0]) +
        String(t.calls).padStart(colW[1]) +
        String(t.tokensIn).padStart(colW[2]) +
        String(t.tokensOut).padStart(colW[3]) +
        String(t.avgMs).padStart(colW[4]) +
        String(t.errors).padStart(colW[5])
      );
    }
    lines.push('');

    lines.push('  TOOL CALL SEQUENCE');
    lines.push(hr2);
    for (const line of callSequence) {
      lines.push(`  ${line}`);
    }
    lines.push('');
    lines.push(hr);

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Print + save
  // ──────────────────────────────────────────────────────────────────────────

  print() {
    const report  = this.buildReport();
    const txtBody = this.buildTextReport(report);

    // Always print to stderr
    process.stderr.write('\n' + txtBody + '\n');

    // Save JSON (machine-readable — good for future dashboards / evals)
    try {
      writeFileSync(this.jsonPath, JSON.stringify(report, null, 2));
      process.stderr.write(`\n  📄 JSON report: ${this.jsonPath}\n`);
    } catch (e) {
      process.stderr.write(`  ⚠️  Could not write JSON report: ${e.message}\n`);
    }

    // Save text copy
    try {
      writeFileSync(this.txtPath, txtBody);
      process.stderr.write(`  📄 Text report: ${this.txtPath}\n\n`);
    } catch (e) {
      process.stderr.write(`  ⚠️  Could not write text report: ${e.message}\n`);
    }

    return report;
  }
}