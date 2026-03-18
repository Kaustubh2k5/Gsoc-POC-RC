import { glob } from 'glob';
import { readFile, writeFile } from 'fs/promises';
import { resolve, relative, dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import { skeletonizeFile, extractSymbol } from '../ts-engine/index.js';

// ─────────────────────────────────────────────
// MD5 cache — skip unchanged files on restart
// ─────────────────────────────────────────────
const CACHE_FILE = '.symbol_cache.json';

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

async function loadCache(repoRoot) {
  const cachePath = resolve(repoRoot, CACHE_FILE);
  if (!existsSync(cachePath)) return {};
  try {
    const raw = await readFile(cachePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveCache(repoRoot, cache) {
  const cachePath = resolve(repoRoot, CACHE_FILE);
  try {
    await writeFile(cachePath, JSON.stringify(cache, null, 2));
  } catch {}
}

// ─────────────────────────────────────────────
// ContentIndex
// ─────────────────────────────────────────────
export class ContentIndex {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.allFiles = [];

    // symbolName → [{ file, kind, line }]
    this.symbolMap = {};

    // Meteor method name → file
    this.meteorMethods = {};

    // file → [importedFile] (resolved relative paths)
    this.importGraph = {};

    // file → [filesThatImportThis] (reverse)
    this.reverseGraph = {};

    this.graphEdges = 0;
    this._ready = false;
    this._cache = {};
  }

  async reindex() {
    this._ready = false;
    this.symbolMap = {};
    this.meteorMethods = {};
    this.importGraph = {};
    this.reverseGraph = {};
    this.graphEdges = 0;
    return this.ensureReady();
  }

  // ─────────────────────────────────────────
  // INIT
  // ─────────────────────────────────────────
  async ensureReady() {
    if (this._ready) return;

    console.error(`[index] starting — repo: ${this.repoRoot}`);

    // 1. Discover all files
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

    console.error(`[index] found ${this.allFiles.length} files`);

    // 2. Load MD5 cache
    this._cache = await loadCache(this.repoRoot);
    let parsed = 0;
    let skipped = 0;
    let cacheUpdated = false;

    // 3. Index all files using tree-sitter
    for (const relFile of this.allFiles) {
      const absPath = resolve(this.repoRoot, relFile);
      try {
        const content = await readFile(absPath, 'utf-8');
        const hash = md5(content);

        if (this._cache[relFile]?.hash === hash) {
          // Cache hit — restore from cache
          const cached = this._cache[relFile];
          this._restoreFromCache(relFile, cached);
          skipped++;
        } else {
          // Cache miss — parse with tree-sitter
          const extracted = await this._parseFile(relFile, absPath, content);
          this._cache[relFile] = { hash, ...extracted };
          this._restoreFromCache(relFile, this._cache[relFile]);
          cacheUpdated = true;
          parsed++;
        }
      } catch (e) {
        console.error(`[index] skip ${relFile}: ${e.message}`);
      }
    }

    // 4. Build reverse graph
    for (const [file, imports] of Object.entries(this.importGraph)) {
      for (const imp of imports) {
        if (!this.reverseGraph[imp]) this.reverseGraph[imp] = [];
        this.reverseGraph[imp].push(file);
        this.graphEdges++;
      }
    }

    // 5. Save cache if anything changed
    if (cacheUpdated) await saveCache(this.repoRoot, this._cache);

    console.error(
      `[index] done — parsed: ${parsed}, cached: ${skipped}, ` +
      `symbols: ${Object.keys(this.symbolMap).length}, ` +
      `meteor: ${Object.keys(this.meteorMethods).length}, ` +
      `edges: ${this.graphEdges}`
    );

    this._ready = true;
  }

  // ─────────────────────────────────────────
  // PARSE — uses tree-sitter via skeletonizeFile
  // ─────────────────────────────────────────
  async _parseFile(relFile, absPath, content) {
    const result = {
      symbols: [],       // [{ name, kind, line }]
      meteorMethods: [], // [name]
      imports: [],       // [resolvedRelativePath]
    };

    try {
      // Get skeleton from tree-sitter engine
      const skelResult = await skeletonizeFile(relFile, this.repoRoot);
      if (skelResult.error) return result;

      // Extract symbols from skeleton metadata if available
      // skeletonizeFile returns { skeleton, symbols?, imports? }
      if (skelResult.symbols) {
        result.symbols = skelResult.symbols;
      } else {
        // Fallback: parse skeleton text for symbol names
        result.symbols = this._extractSymbolsFromSkeleton(skelResult.skeleton, relFile);
      }

      // Extract imports from skeleton metadata or parse manually
      if (skelResult.imports) {
        result.imports = skelResult.imports
          .map(imp => this._resolveImport(imp, relFile))
          .filter(Boolean);
      } else {
        result.imports = this._extractImportsFromContent(content, relFile);
      }

      // Extract Meteor methods
      result.meteorMethods = this._extractMeteorMethods(content, relFile);

    } catch (e) {
      console.error(`[index] parse error ${relFile}: ${e.message}`);
    }

    return result;
  }

  // ─────────────────────────────────────────
  // RESTORE from cache entry into live maps
  // ─────────────────────────────────────────
  _restoreFromCache(relFile, cached) {
    // Symbols
    for (const sym of (cached.symbols || [])) {
      const key = sym.name;
      if (!this.symbolMap[key]) this.symbolMap[key] = [];
      this.symbolMap[key].push({ file: relFile, kind: sym.kind, line: sym.line });
    }

    // Meteor methods
    for (const method of (cached.meteorMethods || [])) {
      this.meteorMethods[method] = relFile;
    }

    // Import graph
    if (cached.imports?.length) {
      this.importGraph[relFile] = cached.imports;
    }
  }

  // ─────────────────────────────────────────
  // SYMBOL EXTRACTION from skeleton text
  // (fallback when tree-sitter doesn't return structured symbols)
  // ─────────────────────────────────────────
  _extractSymbolsFromSkeleton(skeleton, relFile) {
    const symbols = [];
    if (!skeleton) return symbols;

    const lines = skeleton.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // exported function
      const fnMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (fnMatch) {
        symbols.push({ name: fnMatch[1], kind: 'function', line: i });
        continue;
      }

      // class
      const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line: i });
        continue;
      }

      // interface
      const ifaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (ifaceMatch) {
        symbols.push({ name: ifaceMatch[1], kind: 'interface', line: i });
        continue;
      }

      // type alias
      const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)\s*=/);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], kind: 'type', line: i });
        continue;
      }

      // const/let/var export
      const varMatch = line.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (varMatch) {
        symbols.push({ name: varMatch[1], kind: 'variable', line: i });
      }
    }

    return symbols;
  }

  // ─────────────────────────────────────────
  // IMPORT EXTRACTION — parses import statements
  // ─────────────────────────────────────────
  _extractImportsFromContent(content, relFile) {
    const imports = [];
    // Match: import ... from '...'  and  require('...')
    const importRe = /(?:import\s+.*?\s+from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      const spec = m[1];
      // Only follow relative imports for the graph
      if (spec.startsWith('.')) {
        const resolved = this._resolveImport(spec, relFile);
        if (resolved) imports.push(resolved);
      }
    }
    return imports;
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
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return relative(this.repoRoot, candidate);
      }
    }
    return null;
  }

  // ─────────────────────────────────────────
  // METEOR METHOD EXTRACTION
  // Two strategies: AST-aware regex + content scan
  // ─────────────────────────────────────────
  _extractMeteorMethods(content, relFile) {
    const methods = [];

    // Strategy 1: Meteor.methods({ 'methodName': or methodName:
    const blockRe = /Meteor\.methods\s*\(\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
    let blockMatch;
    while ((blockMatch = blockRe.exec(content)) !== null) {
      const block = blockMatch[1];
      // Extract method names from the block
      const nameRe = /^\s*['"]?([\w/:-]+)['"]?\s*(?:\(|:)/gm;
      let nameMatch;
      while ((nameMatch = nameRe.exec(block)) !== null) {
        const name = nameMatch[1];
        if (name && !['function', 'async', 'return', 'if'].includes(name)) {
          methods.push(name);
        }
      }
    }

    // Strategy 2: Meteor.publish
    const publishRe = /Meteor\.publish\s*\(\s*['"]([^'"]+)['"]/g;
    let pubMatch;
    while ((pubMatch = publishRe.exec(content)) !== null) {
      methods.push(`publish:${pubMatch[1]}`);
    }

    return methods;
  }

  // ─────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────

  getStats() {
    return {
      totalFiles: this.allFiles.length,
      totalSymbols: Object.keys(this.symbolMap).length,
      meteorMethods: Object.keys(this.meteorMethods).length,
      graphEdges: this.graphEdges,
    };
  }

  async querySymbol(query, { filePattern, maxResults = 15 } = {}) {
    await this.ensureReady();
    const queryLower = query.toLowerCase();
    const results = [];

    // 1. Exact symbol name match
    for (const [name, locations] of Object.entries(this.symbolMap)) {
      if (name.toLowerCase().includes(queryLower)) {
        for (const loc of locations) {
          if (filePattern && !loc.file.includes(filePattern)) continue;
          results.push({
            file: loc.file,
            score: name.toLowerCase() === queryLower ? 100 : 80,
            symbols: [{ name, kind: loc.kind, line: loc.line }],
            reason: 'Symbol match',
          });
        }
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
            score: 90,
            symbols: [{ name: method, kind: 'meteor_method', line: 0 }],
            reason: 'Meteor method match',
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
          results.push({
            file: f,
            score: 60,
            symbols: [],
            reason: 'Filename match',
          });
        }
        if (results.length >= maxResults) break;
      }
    }

    // Sort by score
    return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  getMeteorMethods() {
    return this.meteorMethods;
  }

  // BFS blast radius — files that import this file, up to maxDepth
  computeBlastRadius(filePath, maxDepth = 3) {
    const rel = filePath.startsWith(this.repoRoot)
      ? relative(this.repoRoot, filePath)
      : filePath;

    const visited = new Set();
    const queue = [{ file: rel, depth: 0 }];
    const result = [];

    while (queue.length > 0) {
      const { file, depth } = queue.shift();
      if (visited.has(file) || depth > maxDepth) continue;
      visited.add(file);
      if (depth > 0) result.push({ file, depth });

      const importers = this.reverseGraph[file] || [];
      for (const importer of importers) {
        if (!visited.has(importer)) {
          queue.push({ file: importer, depth: depth + 1 });
        }
      }
    }

    return result;
  }

  // Files this file imports (direct dependencies)
  getDependencies(filePath) {
    const rel = filePath.startsWith(this.repoRoot)
      ? relative(this.repoRoot, filePath)
      : filePath;
    return this.importGraph[rel] || [];
  }

  // Look up a symbol by exact name
  lookupSymbol(name) {
    return this.symbolMap[name] || [];
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
      const locations = this.symbolMap[query] || [];
      for (const loc of locations) seedFiles.set(loc.file, `symbol:${query}(${loc.kind})`);
      if (this.meteorMethods[query]) seedFiles.set(this.meteorMethods[query], `meteor:${query}`);
      if (locations.length === 0 && !this.meteorMethods[query]) {
        const queryLower = query.toLowerCase();
        for (const [name, locs] of Object.entries(this.symbolMap)) {
          if (name.toLowerCase().includes(queryLower)) {
            for (const loc of locs) seedFiles.set(loc.file, `fuzzy:${name}`);
            if (seedFiles.size >= 5) break;
          }
        }
      }
    }

    if (seedFiles.size === 0) return [];

    const visited = new Map();
    for (const [file, reason] of seedFiles)
      visited.set(file, { depth: 0, reason, score: 100 });

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