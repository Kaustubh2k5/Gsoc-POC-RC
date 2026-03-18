/**
 * Skeletonizer
 * ============
 *
 * Converts a tree-sitter parse tree into an ultra-lean structural skeleton.
 * ~90-97% token reduction vs reading the full file.
 *
 * RESPONSIBILITIES (this module only)
 * ------------------------------------
 *   assembleSkeleton(root, src) → string
 *
 * This module does NOT:
 *   - Load files (that's the public API in index.js)
 *   - Manage parsers (that's ParserPool)
 *   - Find symbols (that's SymbolExtractor)
 *   - Handle fallback when tree-sitter fails (that's TokenStreamFallback)
 *
 * SIGNAL MODEL — five ranked categories
 * --------------------------------------
 *   1. IMPORTS       — dependency graph (always lean, show verbatim)
 *   2. TYPES         — non-exported interfaces/aliases/enums (lean, show verbatim)
 *   3. EXPORTS       — public contract (signatures only, bodies → { ... })
 *   4. REGISTRATIONS — framework wiring (MCP, Meteor, Express, etc.)
 *   5. MODULE-LEVEL  — non-exported top-level declarations
 *
 * The categories are mutually exclusive by design:
 *   - TYPES:   only bare (non-export-wrapped) type nodes
 *   - EXPORTS: only export_statement children
 *   - REGISTRATIONS: only expression_statement children (not exports)
 *   - MODULE-LEVEL: all other top-level declarations
 *
 * REGISTRATION HEURISTIC
 * ----------------------
 * Any top-level expression_statement where the call matches:
 *   Shape A: obj.method('name', [config,] handler)
 *   Shape B: obj.method({ name(params){}, ... })
 * No framework names hardcoded. See queries.js for pattern details.
 */

// =============================================================================
// AST utilities — pure functions, no I/O
// =============================================================================

export const ntext      = (n, s) => s.slice(n.startIndex, n.endIndex);
export const childOf    = (n, ...t) => n.children.find(c => t.includes(c.type)) ?? null;
export const childrenOf = (n, ...t) => n.children.filter(c => t.includes(c.type));
export const hasKind    = (n, ...t) => n.children.some(c => t.includes(c.type));

/** 1-indexed line number of a node */
export const lineOf = (n, s) => s.slice(0, n.startIndex).split('\n').length;

/** Collapse the body of any node to its signature + { ... } */
export function collapsedSig(node, src) {
  const full  = ntext(node, src);
  const brace = full.indexOf('{');
  if (brace === -1) return full.split('\n')[0].trimEnd();
  return full.slice(0, brace).trimEnd() + ' { ... }';
}

// =============================================================================
// Signal extractor 1: Imports
// =============================================================================

export function extractImports(root, src) {
  return root.children
    .filter(n => n.type === 'import_statement')
    .map(n => ntext(n, src));
}

// =============================================================================
// Signal extractor 2: Types (non-exported only)
//
// Exported types belong to extractExports — they must NOT appear here.
// This is enforced by only accepting nodes that are direct children of root
// and are NOT wrapped in an export_statement.
// =============================================================================

export function extractTypes(root, src) {
  const TYPE = new Set(['interface_declaration','type_alias_declaration','enum_declaration']);
  return root.children
    .filter(n => TYPE.has(n.type))  // only bare type nodes (not export-wrapped)
    .map(n => ntext(n, src));
}

// =============================================================================
// Signal extractor 3: Exports
// =============================================================================

export function extractExports(root, src) {
  const out = [];

  for (const node of root.children) {
    if (node.type !== 'export_statement') continue;

    const decl      = node.childForFieldName('declaration');
    const isDefault = hasKind(node, 'default');

    // export { foo, bar } or export * from '...'
    if (!decl) {
      out.push(ntext(node, src).split('\n')[0]);
      continue;
    }

    if (isDefault) {
      out.push('export default ' + collapsedSig(decl, src));
      continue;
    }

    const rendered = renderDecl(decl, src);
    if (rendered) out.push('export ' + rendered);
  }

  return out;
}

// =============================================================================
// Renderers — produce signature-only strings from declaration nodes
// =============================================================================

export function renderDecl(node, src) {
  switch (node.type) {
    case 'function_declaration':
      return renderFnSig(node, src);
    case 'class_declaration':
    case 'abstract_class_declaration':
      return renderClassSig(node, src);
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
      // These are already lean — no bodies to strip
      return ntext(node, src);
    case 'lexical_declaration':
    case 'variable_declaration':
      return renderVarDecl(node, src);
    default:
      return null;
  }
}

export function renderFnSig(node, src) {
  const async_  = hasKind(node, 'async') ? 'async ' : '';
  const name    = node.childForFieldName('name');
  const tParams = node.childForFieldName('type_parameters');
  const params  = node.childForFieldName('parameters') ?? node.childForFieldName('formal_parameters');
  const ret     = node.childForFieldName('return_type');

  return [
    async_,
    'function ',
    name    ? ntext(name, src)    : '<anonymous>',
    tParams ? ntext(tParams, src) : '',
    params  ? ntext(params, src)  : '()',
    ret     ? ntext(ret, src)     : '',
    ' { ... }',
  ].join('');
}

export function renderClassSig(node, src) {
  const abstract_ = hasKind(node, 'abstract') ? 'abstract ' : '';
  const name      = node.childForFieldName('name');
  const tParams   = node.childForFieldName('type_parameters');
  const heritage  = node.childForFieldName('heritage') ?? node.childForFieldName('class_heritage');
  const body      = node.childForFieldName('body');

  // Heritage: strip the class body from the text if present
  const heritageStr = heritage
    ? ' ' + ntext(heritage, src).replace(/\{[\s\S]*/, '').trim()
    : '';

  const header = [
    abstract_,
    'class ',
    name    ? ntext(name, src)    : '<anonymous>',
    tParams ? ntext(tParams, src) : '',
    heritageStr,
    ' {',
  ].join('');

  const members = (body?.children ?? [])
    .map(m => renderMemberSig(m, src))
    .filter(Boolean)
    .map(l => '  ' + l);

  return [header, ...members, '}'].join('\n');
}

export function renderMemberSig(node, src) {
  const MEMBER_TYPES = new Set([
    'method_definition',
    'method_signature',
    'abstract_method_signature',
    'public_field_definition',
    'property_definition',
    'property_signature',
  ]);

  if (!MEMBER_TYPES.has(node.type)) return null;

  const access  = childOf(node, 'accessibility_modifier');
  const name    = node.childForFieldName('name');
  const params  = node.childForFieldName('parameters');
  const ret     = node.childForFieldName('return_type');
  const typeAnn = node.childForFieldName('type');
  const tParams = node.childForFieldName('type_parameters');

  if (!name) return null;

  return [
    access                   ? ntext(access, src) + ' ' : '',
    hasKind(node, 'abstract') ? 'abstract '  : '',
    hasKind(node, 'static')   ? 'static '    : '',
    hasKind(node, 'readonly') ? 'readonly '  : '',
    hasKind(node, 'async')    ? 'async '     : '',
    ntext(name, src),
    tParams ? ntext(tParams, src) : '',
    params  ? ntext(params, src)  : (typeAnn ? ntext(typeAnn, src) : ''),
    ret     ? ntext(ret, src)     : '',
    ';',
  ].join('');
}

export function renderVarDecl(node, src) {
  const kindNode = node.children[0];
  const kind     = kindNode ? ntext(kindNode, src) : 'const';
  const parts    = [];

  for (const d of childrenOf(node, 'variable_declarator')) {
    const name   = d.childForFieldName('name');
    const typeAn = d.childForFieldName('type');
    const value  = d.childForFieldName('value');

    if (!name) continue;

    const nameTxt = ntext(name, src);
    const typeTxt = typeAn ? ntext(typeAn, src) : '';

    if (!value) {
      parts.push(`${kind} ${nameTxt}${typeTxt}`);
      continue;
    }

    switch (value.type) {
      case 'arrow_function':
      case 'function': {
        const a = hasKind(value, 'async') ? 'async ' : '';
        const p = value.childForFieldName('parameters') ?? value.childForFieldName('formal_parameters');
        const r = value.childForFieldName('return_type');
        parts.push(`${kind} ${nameTxt}${typeTxt} = ${a}${p ? ntext(p, src) : '()'}${r ? ntext(r, src) : ''} => { ... }`);
        break;
      }
      case 'new_expression': {
        const ctor = value.childForFieldName('constructor') ?? value.children[1];
        parts.push(`${kind} ${nameTxt}${typeTxt} = new ${ctor ? ntext(ctor, src) : '?'}(...)`);
        break;
      }
      case 'call_expression': {
        const callee = value.childForFieldName('function') ?? value.children[0];
        parts.push(`${kind} ${nameTxt}${typeTxt} = ${callee ? ntext(callee, src) : '?'}(...)`);
        break;
      }
      default: {
        // Primitive, template literal, etc. — show first line up to 80 chars
        const firstLine = ntext(value, src).split('\n')[0].slice(0, 80);
        parts.push(`${kind} ${nameTxt}${typeTxt} = ${firstLine}`);
      }
    }
  }

  return parts.join('\n') || null;
}

// =============================================================================
// Signal extractor 4: Registrations
//
// Framework-agnostic heuristic. Matches any top-level call where:
//   Shape A: obj.method('name', [config,] handler)
//   Shape B: obj.method({ name(params){}, ... })
//
// No framework names hardcoded — works for MCP, Meteor, Express,
// Fastify, tRPC, Electron IPC, socket.io, etc.
// =============================================================================

export function extractRegistrations(root, src) {
  const out = [];
  const FN  = new Set(['arrow_function', 'function', 'function_expression']);
  const STR = new Set(['string', 'template_string', 'string_fragment']);

  for (const node of root.children) {
    if (node.type !== 'expression_statement') continue;

    const expr = node.children.find(c => c.type === 'call_expression');
    if (!expr) continue;

    const calleeNode = expr.childForFieldName('function');
    const argsNode   = expr.childForFieldName('arguments');
    if (!calleeNode || !argsNode) continue;
    if (calleeNode.type !== 'member_expression') continue;

    const callee = ntext(calleeNode, src).trim();
    const args   = argsNode.children.filter(c => ![',', '(', ')'].includes(c.type));
    if (args.length === 0) continue;

    const firstArg = args[0];

    // ── Shape A: ('registeredName', [config,] handlerFn) ────────────────
    if (STR.has(firstArg.type)) {
      if (!args.some(a => FN.has(a.type))) continue;

      const registeredName = ntext(firstArg, src).replace(/^['"`]|['"`]$/g, '');
      const configArg      = args.length >= 3 && args[1]?.type === 'object' ? args[1] : null;
      const { description, paramNames } = configArg
        ? walkConfigObject(configArg, src)
        : { description: '', paramNames: [] };

      // If no params from config, fall back to the handler's own parameter list
      const effectiveParams = paramNames.length > 0
        ? `{ ${paramNames.join(', ')} }`
        : (() => {
            const handler = args.find(a => FN.has(a.type));
            if (!handler) return '';
            const p = handler.childForFieldName('parameters')
                   ?? handler.childForFieldName('formal_parameters');
            if (!p) return '';
            const txt = ntext(p, src);
            const dm  = txt.match(/\{\s*([^}]+)\}/);
            return dm ? `{ ${dm[1].trim()} }` : txt;
          })();

      const descStr = description ? ` /* ${description} */` : '';
      out.push(`${callee}('${registeredName}',${descStr} async (${effectiveParams}) => { ... }); // L${lineOf(node, src)}`);

    // ── Shape B: ({ name(params){} }) ───────────────────────────────────
    } else if (firstArg.type === 'object') {
      const members = childrenOf(firstArg, 'pair', 'method_definition');
      if (members.length === 0) continue;

      const methodLines = [];
      for (const member of members) {
        // childForFieldName('key') does NOT work reliably for method_definition —
        // must scan children directly (documented tree-sitter grammar limitation)
        const keyNode = member.childForFieldName('key')
          ?? member.children.find(c =>
              c.type === 'property_identifier' ||
              c.type === 'string' ||
              c.type === 'identifier'
            );
        if (!keyNode) continue;

        const mName = ntext(keyNode, src).replace(/['"`]/g, '').trim();
        if (!mName || ['async', 'function', 'get', 'set', 'static'].includes(mName)) continue;

        let paramsTxt = '()';
        if (member.type === 'method_definition') {
          const p = member.childForFieldName('parameters');
          if (p) paramsTxt = ntext(p, src);
        } else {
          const val = member.childForFieldName('value');
          if (val) {
            const p = val.childForFieldName('parameters')
                   ?? val.childForFieldName('formal_parameters');
            if (p) paramsTxt = ntext(p, src);
          }
        }

        const async_ = member.children.some(c => c.type === 'async') ? 'async ' : '';
        methodLines.push(`  ${async_}${mName}${paramsTxt} { ... },`);
      }

      if (methodLines.length > 0) {
        out.push(`${callee}({`);
        out.push(...methodLines);
        out.push(`}); // L${lineOf(node, src)}`);
      }
    }
  }

  return out;
}

/**
 * Generic config object walker.
 * Finds 'description' (string value) and leaf identifier keys as param names.
 * Works for zod .shape, plain objects, JSON Schema — no schema knowledge needed.
 */
export function walkConfigObject(objNode, src) {
  const SKIP = new Set([
    'description', 'title', 'shape', 'type', 'default', 'examples',
    'inputSchema', 'argsSchema', 'outputSchema', 'schema',
  ]);
  let description = '';
  const paramNames = [];

  function walk(node, depth) {
    if (depth > 4) return;
    for (const child of childrenOf(node, 'pair', 'property')) {
      const key = child.childForFieldName('key') ?? child.children[0];
      const val = child.childForFieldName('value') ?? child.children[2];
      if (!key) continue;

      const k = ntext(key, src).replace(/['"]/g, '').trim();

      if (k === 'description' && val) {
        const raw = ntext(val, src);
        if (raw.startsWith('[')) {
          // Array of strings joined — e.g. description: ['Line 1', 'Line 2']
          description = [...raw.matchAll(/['"`]([^'"`\n]+)['"`]/g)]
            .map(m => m[1].trim())
            .join(' ')
            .replace(/\s+/g, ' ')
            .slice(0, 150);
        } else {
          description = raw.replace(/^['"`]|['"`]$/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
        }
        continue;
      }

      if (val?.type === 'object') { walk(val, depth + 1); continue; }

      if (!SKIP.has(k) && /^\w+$/.test(k) && k.length <= 40) {
        paramNames.push(k);
      }
    }
  }

  walk(objNode, 0);
  return { description, paramNames: paramNames.slice(0, 10) };
}

// =============================================================================
// Signal extractor 5: Module-level (non-exported top-level declarations)
// =============================================================================

export function extractModuleLevel(root, src) {
  const DECL = new Set([
    'function_declaration', 'class_declaration', 'abstract_class_declaration',
    'lexical_declaration', 'variable_declaration',
  ]);
  const SKIP = new Set(['export_statement', 'import_statement', 'expression_statement']);

  const out = [];
  for (const node of root.children) {
    if (SKIP.has(node.type) || !DECL.has(node.type)) continue;
    const r = renderDecl(node, src);
    if (r) out.push(r);
  }
  return out;
}

// =============================================================================
// Assembly
// =============================================================================

function section(header, items) {
  if (items.length === 0) return [];
  const bar = '─'.repeat(Math.max(0, 38 - header.length));
  return ['', `// ── ${header} ${bar}`, ...items];
}

/**
 * Assemble all five signals into the final skeleton string.
 */
export function assembleSkeleton(root, src) {
  const imports       = extractImports(root, src);
  const types         = extractTypes(root, src);
  const exports_      = extractExports(root, src);
  const registrations = extractRegistrations(root, src);
  const moduleLevel   = extractModuleLevel(root, src);

  return [
    ...imports,
    ...section('Types', types),
    ...section('Exports', exports_),
    ...section('Registrations', registrations),
    ...section('Module-level', moduleLevel),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}