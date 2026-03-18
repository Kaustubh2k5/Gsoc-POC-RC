/**
 * GraphStore
 * ==========
 *
 * Lazy, incremental function-level dependency graph.
 *
 * REPLACES ContentIndex. Key differences:
 *
 *   OLD: index ALL files at startup (~6000 files, slow)
 *   NEW: discover file list at startup (fast), parse lazily on demand
 *
 *   OLD: file-level nodes — blast radius = "which files import this file"
 *   NEW: function-level nodes — blast radius = "which functions call this function"
 *
 * HOW IT WORKS
 * ------------
 * 1. ensureReady()   — globs the repo, populates this.allFiles and
 *                      this.frontier (all files known but unparsed). Fast.
 *
 * 2. ensureFile(f)   — parses one file, creates FunctionNodes, registers
 *                      call edges, queues its imports into the frontier.
 *                      Called by every tool before it touches a file.
 *
 * 3. As the agent explores, the parsed set grows and the graph fills in.
 *    Files the agent never touches stay as cheap frontier stubs.
 *
 * NODE SHAPE
 * ----------
 *   FunctionNode {
 *     id          — 'rel/path.ts::symbolName'
 *     name        — 'symbolName'
 *     kind        — 'function' | 'class' | 'variable' | 'meteor_method' | ...
 *     file        — 'rel/path.ts'
 *     line        — 1-indexed
 *     exported    — boolean
 *     calls       — string[]  (nodeIds this symbol calls, within repo)
 *     calledBy    — string[]  (nodeIds that call this symbol)
 *   }
 *
 * PENDING EDGES
 * -------------
 * When file A calls foo() which is imported from file B, but B hasn't
 * been parsed yet, we store a pending edge. When B is eventually parsed,
 * pending edges pointing to it are resolved and wired up.
 */

import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { resolve, relative, dirname } from 'path';
import { existsSync } from 'fs';
import { skeletonizeFile, extractCallSites } from '../ts-engine/index.js';

// =============================================================================
// GraphStore
// =============================================================================

export class GraphStore {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;

    // All relative file paths discovered by glob
    this.allFiles = [];

    // nodeId → FunctionNode
    this.nodes = new Map();

    // relPath → Set<nodeId>  (all nodes belonging to a file)
    this.fileIndex = new Map();

    // relPath → { discoveredFrom: relPath|null, depth: number }
    // Files we know exist (from imports or glob) but haven't parsed yet
    this.frontier = new Map();

    // relPaths fully parsed
    this.parsed = new Set();

    // Meteor method name → relPath
    this.meteorMethods = {};

    // file → [resolvedRelPath]  (direct import graph, file level)
    this.importGraph = {};

    // file → [files that import it]  (reverse, file level)
    this.reverseGraph = {};

    // Pending cross-file call edges
    // Map<targetNodeId, [{ fromNodeId }]>
    // Stored when A calls B but B isn't parsed yet
    this._pendingEdges = new Map();

    this.graphEdges = 0;
    this._ready = false;
  }

  // ===========================================================================
  // INIT — fast, no parsing
  // ===========================================================================

  async ensureReady() {
    if (this._ready) return;

    console.error(`[graph] starting — repo: ${this.repoRoot}`);

    this.allFiles = await glob('**/*.{ts,tsx,js,jsx}', {
      cwd: this.repoRoot,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/.meteor/**',
      ],
      nodir: true,
    });

    // All files start as frontier (known but unparsed)
    for (const f of this.allFiles) {
      this.frontier.set(f, { discoveredFrom: null, depth: 0 });
    }

    console.error(`[graph] ready — ${this.allFiles.length} files in frontier, 0 parsed`);
    this._ready = true;
  }

  async reindex() {
    this._ready = false;
    this.nodes.clear();
    this.fileIndex.clear();
    this.frontier.clear();
    this.parsed.clear();
    this.meteorMethods = {};
    this.importGraph = {};
    this.reverseGraph = {};
    this._pendingEdges.clear();
    this.graphEdges = 0;
    return this.ensureReady();
  }

  // ===========================================================================
  // LAZY PARSE — called by every tool before touching a file
  // ===========================================================================

  /**
   * Ensure a file is parsed and its immediate imports are queued.
   * Safe to call multiple times — returns immediately if already parsed.
   */
  async ensureFile(relPath, depth = 0) {
    const normalized = relPath.startsWith(this.repoRoot)
      ? relative(this.repoRoot, relPath)
      : relPath;

    if (this.parsed.has(normalized)) return;
    if (!this.allFiles.includes(normalized)) return;

    await this._parseFile(normalized, depth);
  }

  /**
   * Ensure a set of files are parsed (convenience wrapper).
   */
  async ensureFiles(relPaths) {
    for (const f of relPaths) await this.ensureFile(f);
  }

  // ===========================================================================
  // CORE PARSE
  // ===========================================================================

  async _parseFile(relFile, depth = 0) {
    if (this.parsed.has(relFile)) return;

    // Mark parsed immediately to prevent re-entrant calls
    this.parsed.add(relFile);
    this.frontier.delete(relFile);

    const absPath = resolve(this.repoRoot, relFile);
    if (!existsSync(absPath)) return;

    let content;
    try {
      content = await readFile(absPath, 'utf-8');
    } catch {
      return;
    }

    // ── 1. Extract symbols (skeleton gives us names + kinds) ──────────────────
    let symbolList = [];
    try {
      const skelResult = await skeletonizeFile(relFile, this.repoRoot);
      if (!skelResult.error) {
        symbolList = this._extractSymbolsFromSkeleton(skelResult.skeleton);
        // Also grab meteor methods from skeleton result
        if (skelResult.meteorMethods?.length) {
          for (const m of skelResult.meteorMethods) {
            this.meteorMethods[m] = relFile;
          }
        }
      }
    } catch (e) {
      console.error(`[graph] skeleton error ${relFile}: ${e.message}`);
    }

    // ── 2. Create FunctionNodes ───────────────────────────────────────────────
    const fileNodes = new Set();
    for (const sym of symbolList) {
      const nodeId = `${relFile}::${sym.name}`;
      if (!this.nodes.has(nodeId)) {
        this.nodes.set(nodeId, {
          id:       nodeId,
          name:     sym.name,
          kind:     sym.kind,
          file:     relFile,
          line:     sym.line,
          exported: sym.exported ?? false,
          calls:    [],
          calledBy: [],
        });
      }
      fileNodes.add(nodeId);
    }
    this.fileIndex.set(relFile, fileNodes);

    // ── 3. Extract imports ────────────────────────────────────────────────────
    const imports = this._extractImportsFromContent(content, relFile);
    this.importGraph[relFile] = imports;

    for (const imp of imports) {
      // Build reverse graph
      if (!this.reverseGraph[imp]) this.reverseGraph[imp] = [];
      if (!this.reverseGraph[imp].includes(relFile)) {
        this.reverseGraph[imp].push(relFile);
        this.graphEdges++;
      }
      // Queue into frontier if not yet seen
      if (!this.parsed.has(imp) && !this.frontier.has(imp) && this.allFiles.includes(imp)) {
        this.frontier.set(imp, { discoveredFrom: relFile, depth: depth + 1 });
      }
    }

    // ── 4. Extract call sites and wire edges ──────────────────────────────────
    try {
      const callSites = await extractCallSites(relFile, this.repoRoot);
      this._wireCallEdges(relFile, callSites, imports, content);
    } catch (e) {
      console.error(`[graph] call-site error ${relFile}: ${e.message}`);
    }

    // ── 5. Resolve any pending edges that were waiting for this file ──────────
    this._resolvePendingEdges(relFile);

    console.error(`[graph] parsed ${relFile} — ${fileNodes.size} symbols, ${imports.length} imports`);
  }

  // ===========================================================================
  // CALL EDGE WIRING
  // ===========================================================================

  _wireCallEdges(relFile, callSites, imports, content) {
    // Build a map: importedName → resolvedRelFile
    // e.g. { validateMsg: 'apps/lib/validate.ts' }
    const importedNames = this._buildImportNameMap(content, relFile, imports);

    for (const { callerSymbol, calleeRaw } of callSites) {
      // Only care about simple identifier calls, not 'Meteor.call' etc for edges
      // (keep the first segment for member expressions: 'this.db.insert' → 'db')
      const calleeName = calleeRaw.split('.')[0];
      if (!calleeName || calleeName === 'this') continue;

      const callerNodeId = `${relFile}::${callerSymbol}`;
      const targetFile   = importedNames.get(calleeName);

      if (targetFile) {
        // Cross-file edge: A::fn → B::calleeName
        const targetNodeId = `${targetFile}::${calleeName}`;

        if (this.parsed.has(targetFile)) {
          // Target is already parsed — wire immediately
          this._addEdge(callerNodeId, targetNodeId);
        } else {
          // Target not parsed yet — store as pending
          if (!this._pendingEdges.has(targetNodeId)) {
            this._pendingEdges.set(targetNodeId, []);
          }
          this._pendingEdges.get(targetNodeId).push({ fromNodeId: callerNodeId });
        }
      } else {
        // Same-file edge: check if calleeName is a node in this file
        const sameFileNodeId = `${relFile}::${calleeName}`;
        if (this.nodes.has(sameFileNodeId)) {
          this._addEdge(callerNodeId, sameFileNodeId);
        }
      }
    }
  }

  _addEdge(fromId, toId) {
    const from = this.nodes.get(fromId);
    const to   = this.nodes.get(toId);
    if (from && !from.calls.includes(toId))    from.calls.push(toId);
    if (to   && !to.calledBy.includes(fromId)) to.calledBy.push(fromId);
  }

  _resolvePendingEdges(justParsedFile) {
    // Find all pending edges whose target lives in the file we just parsed
    for (const [targetNodeId, pendingList] of this._pendingEdges.entries()) {
      // targetNodeId looks like 'rel/path.ts::symbolName'
      const [targetFile] = targetNodeId.split('::');
      if (targetFile !== justParsedFile) continue;

      for (const { fromNodeId } of pendingList) {
        this._addEdge(fromNodeId, targetNodeId);
      }
      this._pendingEdges.delete(targetNodeId);
    }
  }

  // ===========================================================================
  // HELPERS — symbol / import extraction
  // ===========================================================================

  _extractSymbolsFromSkeleton(skeleton) {
    const symbols = [];
    if (!skeleton) return symbols;

    for (const line of skeleton.split('\n')) {
      const t = line.trim();

      const fn = t.match(/^(export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fn) { symbols.push({ name: fn[2], kind: 'function', exported: !!fn[1] }); continue; }

      const cls = t.match(/^(export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (cls) { symbols.push({ name: cls[2], kind: 'class', exported: !!cls[1] }); continue; }

      const iface = t.match(/^(export\s+)?interface\s+(\w+)/);
      if (iface) { symbols.push({ name: iface[2], kind: 'interface', exported: !!iface[1] }); continue; }

      const type = t.match(/^(export\s+)?type\s+(\w+)\s*=/);
      if (type) { symbols.push({ name: type[2], kind: 'type', exported: !!type[1] }); continue; }

      const varr = t.match(/^(export\s+)?(const|let|var)\s+(\w+)/);
      if (varr) { symbols.push({ name: varr[3], kind: 'variable', exported: !!varr[1] }); continue; }
    }

    return symbols;
  }

  _extractImportsFromContent(content, relFile) {
    const imports = [];
    const importRe = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const resolved = this._resolveImport(spec, relFile);
        if (resolved) imports.push(resolved);
      }
    }
    return imports;
  }

  /**
   * Build a map of { importedIdentifier → resolvedRelFile } for a file.
   * e.g. import { validateMsg, parseContent } from './validate'
   *   → { validateMsg: 'apps/lib/validate.ts', parseContent: 'apps/lib/validate.ts' }
   */
  _buildImportNameMap(content, relFile, resolvedImports) {
    const map = new Map();
    // Match: import { a, b, c } from './something'
    // and:   import defaultName from './something'
    const importRe = /import\s+({[^}]+}|[\w$]+)\s+from\s+['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const specPart = m[1].trim();
      const spec     = m[2];
      if (!spec.startsWith('.')) continue;

      const resolved = this._resolveImport(spec, relFile);
      if (!resolved) continue;

      if (specPart.startsWith('{')) {
        // Named imports
        const names = specPart.slice(1, -1).split(',').map(s => {
          // handle 'originalName as alias' — we want the local alias
          const parts = s.trim().split(/\s+as\s+/);
          return (parts[1] || parts[0]).trim();
        });
        for (const name of names) {
          if (name) map.set(name, resolved);
        }
      } else {
        // Default import
        map.set(specPart, resolved);
      }
    }
    return map;
  }

  _resolveImport(importSpec, fromFile) {
    if (!importSpec.startsWith('.')) return null;
    const fromDir = dirname(resolve(this.repoRoot, fromFile));
    const candidates = [
      resolve(fromDir, importSpec),
      resolve(fromDir, importSpec + '.ts'),
      resolve(fromDir, importSpec + '.tsx'),
      resolve(fromDir, importSpec + '.js'),
      resolve(fromDir, importSpec + '/index.ts'),
      resolve(fromDir, importSpec + '/index.js'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return relative(this.repoRoot, c);
    }
    return null;
  }

  // ===========================================================================
  // PUBLIC API  (same shape as ContentIndex so debug-monitor.js needs
  //              minimal changes)
  // ===========================================================================

  getStats() {
    return {
      totalFiles:    this.allFiles.length,
      totalSymbols:  this.nodes.size,
      meteorMethods: Object.keys(this.meteorMethods).length,
      graphEdges:    this.graphEdges,
      parsedFiles:   this.parsed.size,
      frontierFiles: this.frontier.size,
    };
  }

  getMeteorMethods() {
    return this.meteorMethods;
  }

  lookupSymbol(name) {
    // Returns array of { file, kind, line } — same shape as old ContentIndex
    const results = [];
    for (const [, node] of this.nodes) {
      if (node.name === name) {
        results.push({ file: node.file, kind: node.kind, line: node.line });
      }
    }
    return results;
  }

  async querySymbol(query, { filePattern, maxResults = 15 } = {}) {
    await this.ensureReady();
    const queryLower = query.toLowerCase();
    const results = [];

    // 1. Exact / partial node name match
    for (const [, node] of this.nodes) {
      if (node.name.toLowerCase().includes(queryLower)) {
        if (filePattern && !node.file.includes(filePattern)) continue;
        results.push({
          file:    node.file,
          score:   node.name.toLowerCase() === queryLower ? 100 : 80,
          symbols: [{ name: node.name, kind: node.kind, line: node.line }],
          reason:  'Symbol match',
        });
      }
      if (results.length >= maxResults) break;
    }

    // 2. Meteor method match
    if (results.length < maxResults) {
      for (const [method, file] of Object.entries(this.meteorMethods)) {
        if (method.toLowerCase().includes(queryLower)) {
          if (filePattern && !file.includes(filePattern)) continue;
          results.push({
            file,
            score:   90,
            symbols: [{ name: method, kind: 'meteor_method', line: 0 }],
            reason:  'Meteor method match',
          });
        }
        if (results.length >= maxResults) break;
      }
    }

    // 3. Filename fallback
    if (results.length < maxResults) {
      for (const f of this.allFiles) {
        if (filePattern && !f.includes(filePattern)) continue;
        if (f.toLowerCase().includes(queryLower)) {
          results.push({ file: f, score: 60, symbols: [], reason: 'Filename match' });
        }
        if (results.length >= maxResults) break;
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /**
   * Blast radius — two modes:
   *
   *   nodeId  = 'rel/path.ts::symbolName'
   *             → function-level: returns nodes that transitively call this symbol
   *
   *   filePath = 'rel/path.ts'  (no '::')
   *             → file-level fallback: files that import this file (old behaviour)
   */
  computeBlastRadius(fileOrNodeId, maxDepth = 4) {
    if (fileOrNodeId.includes('::')) {
      return this._blastRadiusNode(fileOrNodeId, maxDepth);
    }
    return this._blastRadiusFile(fileOrNodeId, maxDepth);
  }

  _blastRadiusNode(nodeId, maxDepth) {
    const visited = new Set();
    const queue   = [{ id: nodeId, depth: 0 }];
    const result  = [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift();
      if (visited.has(id) || depth > maxDepth) continue;
      visited.add(id);
      if (depth > 0) result.push({ nodeId: id, depth });

      const node = this.nodes.get(id);
      if (!node) continue;
      for (const callerId of node.calledBy) {
        if (!visited.has(callerId)) queue.push({ id: callerId, depth: depth + 1 });
      }
    }

    return result;
  }

  _blastRadiusFile(filePath, maxDepth) {
    const rel = filePath.startsWith(this.repoRoot)
      ? relative(this.repoRoot, filePath)
      : filePath;

    const visited = new Set();
    const queue   = [{ file: rel, depth: 0 }];
    const result  = [];

    while (queue.length > 0) {
      const { file, depth } = queue.shift();
      if (visited.has(file) || depth > maxDepth) continue;
      visited.add(file);
      if (depth > 0) result.push({ file, depth });

      for (const importer of (this.reverseGraph[file] || [])) {
        if (!visited.has(importer)) queue.push({ file: importer, depth: depth + 1 });
      }
    }

    return result;
  }

  getDependencies(filePath) {
    const rel = filePath.startsWith(this.repoRoot)
      ? relative(this.repoRoot, filePath)
      : filePath;
    return this.importGraph[rel] || [];
  }

  computeScope(symbolsOrFiles, { maxDepth = 2, maxFiles = 60 } = {}) {
    const seedFiles = new Map();

    for (const query of symbolsOrFiles) {
      if (query.match(/\.(ts|tsx|js|jsx)$/)) {
        const rel = query.startsWith(this.repoRoot)
          ? relative(this.repoRoot, query) : query;
        if (this.allFiles.includes(rel)) seedFiles.set(rel, `direct:${query}`);
        continue;
      }

      // Check node names
      for (const [, node] of this.nodes) {
        if (node.name === query) seedFiles.set(node.file, `symbol:${query}(${node.kind})`);
      }

      if (this.meteorMethods[query]) {
        seedFiles.set(this.meteorMethods[query], `meteor:${query}`);
      }

      // Fuzzy fallback
      if (!seedFiles.size) {
        const queryLower = query.toLowerCase();
        for (const [, node] of this.nodes) {
          if (node.name.toLowerCase().includes(queryLower)) {
            seedFiles.set(node.file, `fuzzy:${node.name}`);
            if (seedFiles.size >= 5) break;
          }
        }
      }
    }

    if (seedFiles.size === 0) return [];

    const visited = new Map();
    for (const [file, reason] of seedFiles) {
      visited.set(file, { depth: 0, reason, score: 100 });
    }

    let frontier = [...seedFiles.keys()];

    for (let depth = 1; depth <= maxDepth; depth++) {
      const next = [];
      for (const file of frontier) {
        for (const dep of (this.importGraph[file] || [])) {
          if (!visited.has(dep)) {
            visited.set(dep, { depth, reason: `dep-of:${file}`, score: 100 - depth * 25 });
            next.push(dep);
          }
        }
        if (depth === 1) {
          for (const importer of (this.reverseGraph[file] || [])) {
            if (!visited.has(importer)) {
              visited.set(importer, { depth, reason: `imports:${file}`, score: 60 });
              next.push(importer);
            }
          }
        }
        if (visited.size >= maxFiles) break;
      }
      frontier = next;
      if (visited.size >= maxFiles || frontier.length === 0) break;
    }

    return [...visited.entries()]
      .map(([file, meta]) => ({ file, ...meta }))
      .sort((a, b) => b.score - a.score || a.depth - b.depth)
      .slice(0, maxFiles);
  }
}