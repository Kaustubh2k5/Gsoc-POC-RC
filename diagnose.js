// diagnose.js — run with: node diagnose.js
// Drop this in code-analyzer/ and run it

import Parser from 'tree-sitter';
import TS from 'tree-sitter-typescript';

const grammar = TS.typescript;

console.log('=== Grammar object ===');
console.log('typeof grammar:', typeof grammar);
console.log('grammar.query:', typeof grammar.query);

const p = new Parser();
p.setLanguage(grammar);

console.log('\n=== Parser object ===');
console.log('p.getLanguage:', typeof p.getLanguage);

const lang = p.getLanguage?.();
console.log('\n=== Language from getLanguage() ===');
console.log('typeof lang:', typeof lang);
if (lang) {
  console.log('lang.query:', typeof lang.query);
  console.log('lang keys:', Object.keys(lang).join(', '));
}

// Try actually running a query — this is what will tell us the fix
console.log('\n=== Query attempt ===');
const src = `export function hello(name: string): string { return name; }`;
const tree = p.parse(src);

// Try 1: grammar.query()
try {
  const q = grammar.query(`(function_declaration name: (identifier) @name) @decl`);
  const m = q.matches(tree.rootNode);
  console.log('grammar.query() works! matches:', m.length);
} catch (e) {
  console.log('grammar.query() failed:', e.message);
}

// Try 2: lang.query() via getLanguage()
try {
  const q = lang?.query(`(function_declaration name: (identifier) @name) @decl`);
  const m = q.matches(tree.rootNode);
  console.log('lang.query() works! matches:', m.length);
} catch (e) {
  console.log('lang.query() failed:', e.message);
}

// Try 3: Parser.Language.load() style
try {
  const q = Parser.Language.query?.(`(function_declaration name: (identifier) @name) @decl`);
  console.log('Parser.Language.query:', q);
} catch (e) {
  console.log('Parser.Language.query failed:', e.message);
}