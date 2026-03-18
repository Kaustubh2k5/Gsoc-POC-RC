/**
 * Declaration Finder
 * ==================
 *
 * Finds named declaration nodes in a tree-sitter AST.
 *
 * WHY NO QUERY API
 * ----------------
 * tree-sitter 0.21.1 with prebuilt bindings does not expose
 * language.query() — the grammar object only has:
 *   { name, language, nodeTypeInfo, nodeSubclasses }
 *
 * Instead we use a DEPTH-LIMITED WALK — not a full DFS.
 * Declarations only ever appear at predictable depths:
 *
 *   depth 1 — direct child of root
 *     function foo() {}
 *     class Foo {}
 *     const foo = ...
 *
 *   depth 2 — inside export_statement
 *     export function foo() {}
 *     export class Foo {}
 *     export const foo = ...
 *
 *   depth 3-6 — inside registration call arguments
 *     Meteor.methods({ sendMessage() {} })
 *     server.registerTool('name', config, handler)
 *
 * We never go deeper than 6. For a 50,000-node AST this means
 * visiting ~200-400 nodes instead of all 50,000.
 */

const DECL_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
]);

// =============================================================================
// Public — synchronous, no async needed
// =============================================================================

export function findDeclarationNode(langName, tree, src, symbolName) {
  const root = tree.rootNode;

  const declNode = findTopLevelDecl(root, src, symbolName);
  if (declNode) return declNode;

  const shapeA = findShapeARegistration(root, src, symbolName);
  if (shapeA) return shapeA;

  const shapeB = findShapeBRegistration(root, src, symbolName);
  if (shapeB) return shapeB;

  return null;
}

// =============================================================================
// Strategy 1 — top-level and export-wrapped declarations (depths 1-2)
// =============================================================================

function findTopLevelDecl(root, src, symbolName) {
  for (const node of root.children) {
    if (DECL_TYPES.has(node.type)) {
      const found = matchDecl(node, src, symbolName);
      if (found) return found;
      continue;
    }
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration');
      if (decl && DECL_TYPES.has(decl.type)) {
        const found = matchDecl(decl, src, symbolName);
        if (found) return found;
      }
    }
  }
  return null;
}

function matchDecl(node, src, symbolName) {
  switch (node.type) {
    case 'function_declaration':
    case 'class_declaration':
    case 'abstract_class_declaration':
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode && textOf(nameNode, src) === symbolName) return node;
      break;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const child of node.children) {
        if (child.type === 'variable_declarator') {
          const nameNode = child.childForFieldName('name');
          if (nameNode && textOf(nameNode, src) === symbolName) return node;
        }
      }
      break;
    }
  }
  return null;
}

// =============================================================================
// Strategy 2 — Shape A: obj.method('symbolName', [config,] handler)
// =============================================================================

function findShapeARegistration(root, src, symbolName) {
  for (const node of root.children) {
    if (node.type !== 'expression_statement') continue;
    const expr = node.children.find(c => c.type === 'call_expression');
    if (!expr) continue;
    const fn   = expr.childForFieldName('function');
    const args = expr.childForFieldName('arguments');
    if (!fn || !args || fn.type !== 'member_expression') continue;
    const argList = args.children.filter(c => ![',', '(', ')'].includes(c.type));
    if (argList.length === 0) continue;
    const first = argList[0];
    if (first.type !== 'string' && first.type !== 'template_string') continue;
    const name = textOf(first, src).replace(/^['"`]|['"`]$/g, '');
    if (name === symbolName) return node;
  }
  return null;
}

// =============================================================================
// Strategy 3 — Shape B: obj.method({ symbolName(params){} })
// =============================================================================

function findShapeBRegistration(root, src, symbolName) {
  for (const node of root.children) {
    if (node.type !== 'expression_statement') continue;
    const expr = node.children.find(c => c.type === 'call_expression');
    if (!expr) continue;
    const fn   = expr.childForFieldName('function');
    const args = expr.childForFieldName('arguments');
    if (!fn || !args || fn.type !== 'member_expression') continue;
    const argList = args.children.filter(c => ![',', '(', ')'].includes(c.type));
    if (argList.length === 0 || argList[0].type !== 'object') continue;
    const obj = argList[0];
    for (const member of obj.children) {
      if (member.type === 'method_definition') {
        const keyNode = member.childForFieldName('key')
          ?? member.children.find(c =>
              c.type === 'property_identifier' ||
              c.type === 'identifier' ||
              c.type === 'string'
            );
        if (!keyNode) continue;
        if (textOf(keyNode, src).replace(/['"`]/g, '') === symbolName) return member;
      }
      if (member.type === 'pair') {
        const key = member.childForFieldName('key');
        if (!key) continue;
        if (textOf(key, src).replace(/['"`]/g, '') === symbolName) return member;
      }
    }
  }
  return null;
}

function textOf(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}