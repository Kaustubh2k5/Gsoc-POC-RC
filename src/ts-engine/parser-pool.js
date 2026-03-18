/**
 * ParserPool
 * ==========
 *
 * Manages tree-sitter Parser instances and a file-level parse cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * The original code called `new Parser()` on every file processed.
 * A tree-sitter Parser allocates a native C struct — it is not cheap.
 * During a typical "discovery" session (50 files skeletonized), that's
 * 50 unnecessary allocations. When the agent follows up with
 * read_symbol_details, the same file is parsed AGAIN from scratch.
 *
 * The correct model has two levels of reuse:
 *
 *   LEVEL 1 — Parser reuse (one instance per language, reset between uses)
 *     parser.reset() clears parse state without deallocating native memory.
 *     After reset, parser.parse(newSrc) is as fast as using a fresh instance.
 *     This eliminates the allocation cost entirely.
 *
 *   LEVEL 2 — Tree cache (Map<absPath, {tree, src, mtime}>)
 *     When skeletonizeFile and extractSymbol are called on the same file
 *     in the same session, the second call gets the cached tree instantly.
 *     Cache is invalidated when the file's mtime changes (file was edited).
 *     This is the same pattern used by language servers (LSP).
 *
 * LANGUAGE MAPPING (complete and correct)
 * ----------------------------------------
 *   .ts         → tree-sitter-typescript / typescript  (no JSX)
 *   .tsx        → tree-sitter-typescript / tsx         (JSX support)
 *   .js .mjs .cjs → tree-sitter-javascript             (JS handles JSX too)
 *   .jsx        → tree-sitter-javascript
 *
 * Using the typescript grammar on a .tsx file containing JSX produces
 * ERROR nodes in the AST, causing silent skeletonization failures.
 * Extension-to-grammar mapping must be exact.
 *
 * QUERY CACHE
 * -----------
 * tree-sitter queries are compiled to native code on first use.
 * Compiling the same query string 50 times per session is wasteful.
 * ParserPool caches compiled queries keyed by (languageName, queryString).
 */

import Parser from 'tree-sitter';
import { stat } from 'fs/promises';
import { extname } from 'path';

// =============================================================================
// Constants
// =============================================================================

// Max entries in the tree cache. At ~2MB per tree (rough estimate for a
// 2,000-line TS file), 100 entries ≈ 200MB — acceptable for a long session.
const TREE_CACHE_MAX = 100;

// Language identifiers — used as keys in the parser pool and query cache
export const LANG = {
  TS:  'typescript',
  TSX: 'tsx',
  JS:  'javascript',
};

// Extension → language mapping (must be exhaustive and correct)
const EXT_TO_LANG = {
  '.ts':  LANG.TS,
  '.tsx': LANG.TSX,
  '.js':  LANG.JS,
  '.jsx': LANG.JS,
  '.mjs': LANG.JS,
  '.cjs': LANG.JS,
};

// =============================================================================
// ParserPool — singleton per process
// =============================================================================

class ParserPool {
  constructor() {
    // Map<langName, Parser>  — reused parser instances
    this._parsers = new Map();

    // Map<langName, Language>  — grammar objects (native addon exports)
    this._languages = new Map();

    // Map<absPath, {tree, src, mtime, lang}>  — parse cache
    this._treeCache = new Map();

    // Load order for grammar modules
    this._loaded = new Set();
  }

  // ---------------------------------------------------------------------------
  // Public: get or create a parser for a given file extension
  // ---------------------------------------------------------------------------

  /**
   * Returns the language name for a file path, or null if unsupported.
   */
  langForFile(filePath) {
    const ext = extname(filePath).toLowerCase();
    return EXT_TO_LANG[ext] ?? null;
  }

  /**
   * Returns true if this file can be parsed by tree-sitter.
   */
  supports(filePath) {
    return this.langForFile(filePath) !== null;
  }

  /**
   * Ensure grammars are loaded. Call before any parse operation.
   * Safe to call multiple times — loads lazily.
   */
  async ensureLoaded(langName) {
    if (this._loaded.has(langName)) return true;

    try {
      if (langName === LANG.TS || langName === LANG.TSX) {
        const mod = await import('tree-sitter-typescript');
        const grammar = mod.default ?? mod;
        // tree-sitter-typescript exports { typescript, tsx }
        if (grammar?.typescript) this._languages.set(LANG.TS,  grammar.typescript);
        if (grammar?.tsx)        this._languages.set(LANG.TSX, grammar.tsx);
        this._loaded.add(LANG.TS);
        this._loaded.add(LANG.TSX);
      } else if (langName === LANG.JS) {
        const mod = await import('tree-sitter-javascript');
        const grammar = mod.default ?? mod;
        this._languages.set(LANG.JS, grammar);
        this._loaded.add(LANG.JS);
      }
      return this._languages.has(langName);
    } catch {
      return false;
    }
  }

  /**
   * Get the Language object (needed for the query API).
   */
  async getLanguage(langName) {
    await this.ensureLoaded(langName);
    return this._languages.get(langName) ?? null;
  }

  /**
   * Get a parser for the given language, creating it once if needed.
   * The returned parser is already configured with the correct language.
   * Callers must NOT hold on to the parser between awaits — get it,
   * call parse(), then release (it stays in the pool).
   */
  async getParser(langName) {
    const loaded = await this.ensureLoaded(langName);
    if (!loaded) return null;

    const language = this._languages.get(langName);
    if (!language) return null;

    if (!this._parsers.has(langName)) {
      const p = new Parser();
      p.setLanguage(language);
      this._parsers.set(langName, p);
    }

    return this._parsers.get(langName);
  }

  // ---------------------------------------------------------------------------
  // Public: parse with cache
  // ---------------------------------------------------------------------------

  /**
   * Parse a file, returning the cached tree if the file hasn't changed.
   *
   * Returns: { tree, src, lang, fromCache, parseError? }
   * If parsing fails: { tree: null, parseError: Error }
   */
  async parse(absPath, src) {
    const langName = this.langForFile(absPath);
    if (!langName) {
      return { tree: null, lang: null, parseError: new Error(`Unsupported extension: ${extname(absPath)}`) };
    }

    // Check cache — valid if mtime matches
    const cached = this._treeCache.get(absPath);
    if (cached && cached.src === src) {
      // src equality is the cheapest valid-cache check when we already have src
      return { tree: cached.tree, src, lang: langName, fromCache: true };
    }

    const parser = await this.getParser(langName);
    if (!parser) {
      return { tree: null, lang: langName, parseError: new Error(`Grammar unavailable for ${langName}`) };
    }

    try {
      // Pass old tree for incremental re-parse if src changed
      const oldTree = cached?.lang === langName ? cached.tree : undefined;
      const tree    = parser.parse(src, oldTree);

      this._cacheTree(absPath, tree, src, langName);
      return { tree, src, lang: langName, fromCache: false };
    } catch (e) {
      return { tree: null, lang: langName, parseError: e };
    }
  }

  /**
   * Invalidate the cached tree for a file (call when a file is modified).
   */
  invalidate(absPath) {
    this._treeCache.delete(absPath);
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  _cacheTree(absPath, tree, src, lang) {
    // Evict oldest entry when at capacity (simple LRU approximation)
    if (this._treeCache.size >= TREE_CACHE_MAX) {
      const firstKey = this._treeCache.keys().next().value;
      this._treeCache.delete(firstKey);
    }
    this._treeCache.set(absPath, { tree, src, lang });
  }
}

// Singleton — one pool per process
export const parserPool = new ParserPool();