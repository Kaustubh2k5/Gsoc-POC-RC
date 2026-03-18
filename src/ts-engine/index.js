/**
 * Tree-Sitter Engine — Public API
 * =================================
 *
 * The single import surface for all tree-sitter functionality.
 *
 * EXPORTS
 * -------
 *   skeletonizeFile(filePath, repoRoot)
 *     → { skeleton, meteorMethods, stats }
 *
 *   extractSymbol(filePath, symbolName, repoRoot)
 *     → { source, lineStart, lineEnd, engine }
 *
 *   extractMeteorMethods(filePath, repoRoot)
 *     → string[]
 *
 *   extractCallSites(filePath, repoRoot)
 *     → [{ callerSymbol, calleeRaw, line }]
 *     Walks all call_expression nodes in the file and returns the raw
 *     callee identifier text plus which top-level symbol the call lives
 *     inside. Used by GraphStore to build function-level call edges.
 *
 * ARCHITECTURE
 * ------------
 * This module orchestrates four layers:
 *
 *   ParserPool    — singleton parsers + tree cache + query cache
 *   queries.js    — compiled S-expression patterns for symbol finding
 *   skeletonizer.js — pure signal extraction from a tree
 *   fallback.js   — token-stream fallback when tree-sitter is unavailable
 *
 * No layer knows about any other layer except this one.
 * All error handling and fallback decisions happen here.
 */
import { readFile }     from 'fs/promises';
import { existsSync }   from 'fs';
import { resolve, extname } from 'path';
import { parserPool }           from './parser-pool.js';
import { findDeclarationNode }  from './queries.js';
import { assembleSkeleton, ntext } from './skeletonizer.js';
import { tokenStreamFallback }  from './fallback.js';

// =============================================================================
// Helpers
// =============================================================================

async function readSrc(filePath, repoRoot) {
  const abs = resolve(repoRoot, filePath);
  if (!existsSync(abs)) return null;
  return readFile(abs, 'utf-8');
}

// =============================================================================
// skeletonizeFile
// =============================================================================

export async function skeletonizeFile(filePath, repoRoot) {
  const abs = resolve(repoRoot, filePath);

  if (!existsSync(abs)) {
    return { error: `File not found: ${filePath}` };
  }

  const src = await readFile(abs, 'utf-8');
  const originalLines = src.split('\n').length;

  if (!parserPool.supports(abs)) {
    const fallback = tokenStreamFallback(src);
    return {
      skeleton: fallback.skeleton,
      meteorMethods: [],
      stats: {
        engine: 'token-stream-fallback',
        originalLines,
        skeletonLines: fallback.skeleton.split('\n').length,
        reductionPct: Math.round((1 - fallback.skeleton.length / src.length) * 100),
      },
    };
  }

  const { tree, parseError } = await parserPool.parse(abs, src);

  if (!tree || parseError) {
    const fallback = tokenStreamFallback(src);
    return {
      skeleton: fallback.skeleton,
      meteorMethods: [],
      stats: {
        engine: 'token-stream-fallback',
        originalLines,
        skeletonLines: fallback.skeleton.split('\n').length,
        reductionPct: Math.round((1 - fallback.skeleton.length / src.length) * 100),
        parseError: parseError?.message,
      },
    };
  }

  try {
    const skeleton = assembleSkeleton(tree.rootNode, src);
    const meteorMethods = extractMeteorMethodsFromTree(tree.rootNode, src);
    const skeletonLines = skeleton.split('\n').length;

    return {
      skeleton,
      meteorMethods,
      stats: {
        engine: 'tree-sitter',
        originalLines,
        skeletonLines,
        reductionPct: Math.round((1 - skeletonLines / originalLines) * 100),
      },
    };
  } catch (e) {
    const fallback = tokenStreamFallback(src);
    return {
      skeleton: fallback.skeleton,
      meteorMethods: [],
      stats: {
        engine: 'token-stream-fallback',
        originalLines,
        skeletonLines: fallback.skeleton.split('\n').length,
        reductionPct: Math.round((1 - fallback.skeleton.length / src.length) * 100),
        parseError: e.message,
      },
    };
  }
}

// =============================================================================
// extractSymbol
// =============================================================================

export async function extractSymbol(filePath, symbolName, repoRoot) {
  const abs = resolve(repoRoot, filePath);

  if (!existsSync(abs)) {
    return { error: `File not found: ${filePath}`, engine: 'none' };
  }

  const src = await readFile(abs, 'utf-8');

  if (!parserPool.supports(abs)) {
    return regexExtractSymbol(src, symbolName);
  }

  const { tree, parseError } = await parserPool.parse(abs, src);
  if (!tree || parseError) {
    return regexExtractSymbol(src, symbolName);
  }

  const langName = parserPool.langForFile(abs);
  const node = findDeclarationNode(langName, tree, src, symbolName);

  if (!node) {
    return regexExtractSymbol(src, symbolName);
  }

  return {
    source:    ntext(node, src),
    lineStart: node.startPosition.row + 1,
    lineEnd:   node.endPosition.row + 1,
    engine:    'tree-sitter',
  };
}

// =============================================================================
// extractMeteorMethods
// =============================================================================

export async function extractMeteorMethods(filePath, repoRoot) {
  const src = await readSrc(filePath, repoRoot);
  if (!src) return [];
  const abs = resolve(repoRoot, filePath);
  const { tree } = await parserPool.parse(abs, src);
  if (!tree) return [];
  return extractMeteorMethodsFromTree(tree.rootNode, src);
}

// =============================================================================
// extractCallSites  ← NEW
// =============================================================================
//
// Walks the AST and returns every call_expression found in the file.
// For each call, we report:
//   callerSymbol  — name of the top-level function/class/variable this call
//                   lives inside (or '<module>' for top-level expressions)
//   calleeRaw     — raw text of the callee (e.g. 'validateMsg',
//                   'this.db.insert', 'Meteor.call')
//   line          — 1-indexed source line of the call
//
// Only relative/same-file calls matter for the function graph; the caller
// is responsible for filtering out calls to external packages.

export async function extractCallSites(filePath, repoRoot) {
  const abs = resolve(repoRoot, filePath);
  if (!existsSync(abs)) return [];

  const src = await readFile(abs, 'utf-8');

  if (!parserPool.supports(abs)) {
    return extractCallSitesRegex(src);
  }

  const { tree, parseError } = await parserPool.parse(abs, src);
  if (!tree || parseError) {
    return extractCallSitesRegex(src);
  }

  const results = [];
  walkCallSites(tree.rootNode, src, '<module>', results);
  return results;
}

// ---------------------------------------------------------------------------
// AST walk for call sites
// ---------------------------------------------------------------------------

function walkCallSites(node, src, currentSymbol, results) {
  // When we enter a named declaration, update currentSymbol so calls inside
  // are attributed to the right function/class/variable.
  const declName = getDeclName(node, src);
  const symbol = declName ?? currentSymbol;

  if (node.type === 'call_expression') {
    const calleeNode = node.childForFieldName('function');
    if (calleeNode) {
      const calleeRaw = ntext(calleeNode, src).trim();
      // Skip very long callee strings (template expressions etc.)
      if (calleeRaw.length < 120) {
        results.push({
          callerSymbol: symbol,
          calleeRaw,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  for (const child of node.children) {
    walkCallSites(child, src, symbol, results);
  }
}

// Returns the declared name if this node is a named declaration, else null.
function getDeclName(node, src) {
  switch (node.type) {
    case 'function_declaration':
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'interface_declaration': {
      const n = node.childForFieldName('name');
      return n ? ntext(n, src) : null;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      // e.g. const myFn = () => { ... }
      for (const child of node.children) {
        if (child.type === 'variable_declarator') {
          const n = child.childForFieldName('name');
          if (n) return ntext(n, src);
        }
      }
      return null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Regex fallback for call sites (when tree-sitter unavailable)
// ---------------------------------------------------------------------------

function extractCallSitesRegex(src) {
  const results = [];
  const lines = src.split('\n');
  // Very rough: match identifier( or identifier.method(
  const callRe = /\b([\w$][\w$]*(?:\.[\w$]+)*)\s*\(/g;
  // Skip these — they're declarations not calls
  const SKIP = new Set(['function', 'if', 'for', 'while', 'switch', 'catch', 'class']);

  for (let i = 0; i < lines.length; i++) {
    let m;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(lines[i])) !== null) {
      const callee = m[1];
      if (!SKIP.has(callee)) {
        results.push({ callerSymbol: '<module>', calleeRaw: callee, line: i + 1 });
      }
    }
  }
  return results;
}

// =============================================================================
// Internal helpers
// =============================================================================

function extractMeteorMethodsFromTree(rootNode, src) {
  const methods = [];
  for (const node of rootNode.children) {
    if (node.type !== 'expression_statement') continue;
    const expr = node.children.find(c => c.type === 'call_expression');
    if (!expr) continue;
    const fn = expr.childForFieldName('function');
    if (!fn || ntext(fn, src) !== 'Meteor.methods') continue;
    const args = expr.childForFieldName('arguments');
    if (!args) continue;
    const obj = args.children.find(c => c.type === 'object');
    if (!obj) continue;
    for (const member of obj.children) {
      if (member.type === 'method_definition' || member.type === 'pair') {
        const key = member.childForFieldName('key')
          ?? member.children.find(c =>
              c.type === 'property_identifier' ||
              c.type === 'string' ||
              c.type === 'identifier'
            );
        if (key) {
          const name = ntext(key, src).replace(/['"]/g, '').trim();
          if (name) methods.push(name);
        }
      }
    }
  }
  return methods;
}

function regexExtractSymbol(src, symbolName) {
  const lines = src.split('\n');
  const esc   = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const patterns = [
    new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${esc}\\s*[(<]`),
    new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+${esc}\\s*[{<(]`),
    new RegExp(`^(?:export\\s+)?interface\\s+${esc}\\s*[{<]`),
    new RegExp(`^(?:export\\s+)?type\\s+${esc}\\s*=`),
    new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*[=:]`),
    new RegExp(`^\\s{2,6}(?:async\\s+)?${esc}\\s*\\(`),
    new RegExp(`^\\s*['"\`]${esc}['"\`]\\s*:`),
  ];

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some(p => p.test(lines[i]))) { startLine = i; break; }
  }

  if (startLine === -1) {
    return { source: null, error: `Symbol '${symbolName}' not found`, engine: 'regex-fallback' };
  }

  let depth = 0, opened = false, endLine = startLine;
  for (let i = startLine; i < lines.length; i++) {
    let inStr = false, sc = '';
    for (let j = 0; j < lines[i].length; j++) {
      const ch = lines[i][j];
      if (inStr) {
        if (ch === sc && lines[i][j - 1] !== '\\') inStr = false;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = true; sc = ch;
      } else if (ch === '{') {
        depth++; opened = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    endLine = i;
    if (!opened && i > startLine) {
      if (lines[i].trimEnd().endsWith(';') || lines[i].trimEnd().endsWith(',')) break;
    }
    if (opened && depth === 0) break;
  }

  return {
    source:    lines.slice(startLine, endLine + 1).join('\n'),
    lineStart: startLine + 1,
    lineEnd:   endLine + 1,
    engine:    'regex-fallback',
  };
}