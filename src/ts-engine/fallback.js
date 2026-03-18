/**
 * Token-Stream Fallback
 * =====================
 *
 * Implements the same five-signal skeletonization model as the tree-sitter
 * path, but using a character scanner instead of an AST.
 *
 * Used when:
 *   - tree-sitter native addon is not compiled/installed
 *   - The grammar fails to parse a file (new TS syntax, malformed file)
 *   - File extension is supported but grammar load failed
 *
 * DESIGN PRINCIPLE
 * ----------------
 * The fallback must produce STRUCTURALLY IDENTICAL output to the AST path.
 * The model consuming the skeleton should see the same format regardless
 * of which engine ran. The only difference is the stats.engine field.
 *
 * SCANNER DESIGN
 * --------------
 * Uses a character-level brace depth tracker that respects string boundaries.
 * This is more reliable than regex for multi-line constructs like:
 *
 *   server.registerTool('name', {
 *     description: 'a string with { braces }',
 *   }, async () => { ... })
 *
 * A naive brace-counter would stop at the { inside the string.
 * This scanner tracks whether it's inside a string before counting braces.
 */

// =============================================================================
// Public
// =============================================================================

/**
 * Generate a skeleton using the token-stream approach.
 * Same return shape as skeletonizeFile in the AST path.
 */
export function tokenStreamFallback(src, filePath) {
  const lines = src.split('\n');
  const acc   = { imports: [], types: [], exports: [], registrations: [], moduleLevel: [] };
  const meteorMethods = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // ── 1. Imports ──────────────────────────────────────────────────────
    if (/^import\s+/.test(trimmed)) {
      let text = lines[i], j = i;
      // Multi-line import — read until 'from ...' line
      while (j < lines.length && !lines[j].includes(' from ') && !lines[j].trimEnd().endsWith(';')) {
        j++;
        if (j < lines.length) text += '\n' + lines[j];
      }
      acc.imports.push(text);
      i = j;
      continue;
    }

    // ── 2+3. Exports (types included — no separate pass needed) ─────────
    if (/^export\s+/.test(trimmed)) {
      acc.exports.push(blockSig(lines, i));
      i = findBlockEnd(lines, i);
      continue;
    }

    // ── 4. Registration heuristic — Shape A: obj.method('name', ...) ────
    const regA = trimmed.match(/^([\w$]+)\.([\w$]+)\s*\(\s*(['"`])([^'"`\s]+)\3\s*,/);
    if (regA) {
      const end   = findBlockEnd(lines, i);
      const block = lines.slice(i, end + 1).join('\n');
      const hasFn = /=>\s*\{|function\s*[({]|async\s*[(]/.test(block);

      if (hasFn) {
        const desc   = extractDescription(block);
        const params = extractParams(block);

        // Special case: Meteor.methods Shape A (rare but valid)
        if (regA[1] === 'Meteor' && regA[2] === 'methods') {
          for (const mm of block.matchAll(/^\s{2,6}(?:async\s+)?(['"]?)(\w[\w./-]*)\1\s*[:(]/gm)) {
            if (!['async','function','const','let','var','return'].includes(mm[2])) {
              meteorMethods.push(mm[2]);
            }
          }
        }

        const paramStr = params.length ? `{ ${params.join(', ')} }` : '';
        const descStr  = desc ? ` /* ${desc} */` : '';
        acc.registrations.push(
          `${regA[1]}.${regA[2]}('${regA[4]}',${descStr} async (${paramStr}) => { ... }); // L${i + 1}`
        );
        i = end;
        continue;
      }
    }

    // ── 4b. Registration Shape B: obj.method({ ... }) ───────────────────
    const regB = trimmed.match(/^([\w$]+)\.([\w$]+)\s*\(\s*\{/);
    if (regB) {
      const end   = findBlockEnd(lines, i);
      const block = lines.slice(i, end + 1).join('\n');

      // Collect method names from the object
      const methodLines = [];
      for (const m of block.matchAll(/^\s{2,6}(?:async\s+)?([\w$]+)\s*[:(]/gm)) {
        const name = m[1];
        if (['async','function','return','if','for','const','let','var'].includes(name)) continue;
        const isAsync = /async\s+/.test(m[0]);
        methodLines.push(`  ${isAsync ? 'async ' : ''}${name}(...) { ... },`);
        if (regB[1] === 'Meteor' && regB[2] === 'methods') meteorMethods.push(name);
      }

      if (methodLines.length > 0) {
        acc.registrations.push(`${regB[1]}.${regB[2]}({`);
        acc.registrations.push(...methodLines);
        acc.registrations.push(`}); // L${i + 1}`);
      }

      i = end;
      continue;
    }

    // ── 5. Module-level declarations ────────────────────────────────────
    if (
      /^(?:async\s+)?function[\s*]/.test(trimmed) ||
      /^(?:abstract\s+)?class\s+\w+/.test(trimmed) ||
      /^(?:const|let|var)\s+\w+/.test(trimmed)
    ) {
      acc.moduleLevel.push(blockSig(lines, i));
      i = findBlockEnd(lines, i);
    }
  }

  const skeleton = buildOutput(acc);
  const originalLines = lines.length;
  const skeletonLines = skeleton.split('\n').filter(Boolean).length;

  return {
    skeleton,
    meteorMethods,
    stats: {
      originalLines,
      skeletonLines,
      reductionPct: Math.round((1 - skeletonLines / originalLines) * 100),
      filePath,
      engine: 'token-stream-fallback',
    },
  };
}

// =============================================================================
// Scanner utilities
// =============================================================================

/**
 * Find the closing line index of a brace-delimited block starting at startLine.
 * Respects string literals — braces inside strings don't count.
 */
function findBlockEnd(lines, startLine) {
  let depth = 0, opened = false;

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

    if (opened && depth <= 0) return i;
  }

  return lines.length - 1;
}

/**
 * Collapse a block to its signature + { ... }.
 */
function blockSig(lines, lineIdx) {
  const line  = lines[lineIdx];
  const brace = line.indexOf('{');
  if (brace === -1) return line.trimEnd();
  return line.slice(0, brace).trimEnd() + ' { ... }';
}

/**
 * Generic 'description' key extractor from a block of text.
 */
function extractDescription(block) {
  const m = block.match(/description\s*:\s*(?:\[([^\]]*)\]|['"`]([^'"`]{3,}?)['"`])/);
  if (!m) return '';
  if (m[1]) {
    return [...m[1].matchAll(/['"`]([^'"`\n]+)['"`]/g)]
      .map(x => x[1].trim()).join(' ').replace(/\s+/g, ' ').slice(0, 150);
  }
  return m[2].replace(/\s+/g, ' ').trim().slice(0, 150);
}

/**
 * Extract param-like keys from a block (deeply-indented identifier: value lines).
 */
function extractParams(block) {
  const SKIP = new Set(['description','title','shape','type','default','inputSchema','argsSchema','schema']);
  return [...block.matchAll(/^[ \t]{6,}(\w+)\s*:/gm)]
    .map(m => m[1])
    .filter(p => !SKIP.has(p) && /^\w+$/.test(p) && p.length <= 40)
    .slice(0, 10);
}

// =============================================================================
// Output assembly (same section format as the AST path)
// =============================================================================

function section(header, items) {
  if (items.length === 0) return [];
  const bar = '─'.repeat(Math.max(0, 38 - header.length));
  return ['', `// ── ${header} ${bar}`, ...items];
}

function buildOutput(acc) {
  return [
    ...acc.imports,
    ...section('Types',         acc.types),
    ...section('Exports',       acc.exports),
    ...section('Registrations', acc.registrations),
    ...section('Module-level',  acc.moduleLevel),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}