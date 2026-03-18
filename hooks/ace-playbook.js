#!/usr/bin/env node
/**
 * ACE Playbook — AfterAgent Hook
 *
 * Fires after the agent loop completes. Receives the full session transcript
 * and runs the Reflector → Curator pipeline:
 *
 *   1. Reflector: Extracts "Actionable Lessons" from the transcript
 *      (patterns, file locations, conventions discovered during this session)
 *   2. Curator: Deduplicates and merges lessons into GEMINI.md (the Playbook)
 *      using cosine similarity on simple TF-IDF vectors (no external ML deps)
 *
 * The playbook is loaded automatically by gemini-cli at the start of every
 * session, giving the agent a "cheat sheet" of repository-specific strategies.
 * This prevents re-discovery costs (up to 75.1% session cost reduction).
 *
 * Usage (gemini-extension.json):
 *   "AfterAgent": { "command": "node", "args": ["hooks/ace-playbook.js"] }
 */

import { readFile, writeFile, access } from 'fs/promises';
import { join, resolve } from 'path';
import { constants } from 'fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SIMILARITY_THRESHOLD = 0.82;  // Deduplicate lessons with similarity > this
const MAX_PLAYBOOK_LESSONS = 120;    // Cap to prevent playbook bloat
const PLAYBOOK_FILENAME = 'GEMINI.md';
const LESSON_SECTION_HEADER = '## 🧠 ACE Playbook — Learned Strategies';

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main() {
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += chunk;

  if (!input.trim()) { process.exit(0); }

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const transcript = payload?.session_transcript ?? payload?.transcript ?? null;
  const workspaceRoot = payload?.workspace_root
    ?? process.env.REPO_ROOT
    ?? process.cwd();

  if (!transcript) {
    log('[ACEPlaybook] No transcript found in payload — skipping.');
    process.exit(0);
  }

  // 1. Reflect: extract lessons from this session
  const rawLessons = extractLessons(transcript);
  log(`[ACEPlaybook] Extracted ${rawLessons.length} raw lessons from session.`);

  if (rawLessons.length === 0) {
    process.exit(0);
  }

  // 2. Load existing playbook
  const playbookPath = findPlaybookPath(workspaceRoot);
  const existingContent = await loadPlaybook(playbookPath);
  const existingLessons = parseExistingLessons(existingContent);

  // 3. Curate: deduplicate and merge
  const newLessons = curateLessons(rawLessons, existingLessons);
  log(`[ACEPlaybook] ${newLessons.length} new lessons after deduplication.`);

  if (newLessons.length === 0) {
    log('[ACEPlaybook] All lessons already in playbook — nothing to update.');
    process.exit(0);
  }

  // 4. Write updated playbook
  const allLessons = [...existingLessons, ...newLessons].slice(-MAX_PLAYBOOK_LESSONS);
  const updatedContent = buildPlaybookContent(existingContent, allLessons);

  try {
    await writeFile(playbookPath, updatedContent, 'utf-8');
    log(`[ACEPlaybook] Playbook updated at ${playbookPath} (+${newLessons.length} lessons, ${allLessons.length} total)`);
  } catch (e) {
    log(`[ACEPlaybook] Failed to write playbook: ${e.message}`);
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Reflector: extract actionable lessons from session transcript
// ---------------------------------------------------------------------------
function extractLessons(transcript) {
  const lessons = [];
  const text = typeof transcript === 'string'
    ? transcript
    : JSON.stringify(transcript);

  // Pattern 1: File location discoveries
  // "found in apps/meteor/server/methods/sendMessage.ts"
  const fileMatches = text.matchAll(/(?:found|located|implemented|defined)\s+in\s+([\w\/.@-]+\.(ts|js|tsx|jsx))/gi);
  for (const m of fileMatches) {
    lessons.push({
      type: 'file-location',
      text: `File location: ${m[1].trim()}`,
      confidence: 0.7,
    });
  }

  // Pattern 2: Meteor method mappings
  // "Meteor.call('sendMessage')" or "Meteor.methods({ 'sendMessage'"
  const meteorMatches = text.matchAll(/Meteor\.(?:call|methods)\s*\(\s*['"]([^'"]+)['"]/g);
  for (const m of meteorMatches) {
    lessons.push({
      type: 'meteor-method',
      text: `Meteor method '${m[1]}' discovered in session`,
      confidence: 0.85,
    });
  }

  // Pattern 3: Import alias resolutions
  // "@rocket.chat/ui-kit → packages/..."
  const aliasMatches = text.matchAll(/@([\w./-]+)\s*(?:→|->|resolves to|is at)\s*([\w/.@-]+)/gi);
  for (const m of aliasMatches) {
    lessons.push({
      type: 'alias',
      text: `Import alias @${m[1]} resolves to ${m[2]}`,
      confidence: 0.9,
    });
  }

  // Pattern 4: Agent-stated conventions (look for reasoning block patterns)
  // "I learned that...", "The pattern is...", "Always use..."
  const conventionMatches = text.matchAll(/(?:I (?:learned|discovered|found) that|The pattern (?:is|for)|Always use|Convention:|Note:)\s+([^.!?\n]{20,150}[.!?])/gi);
  for (const m of conventionMatches) {
    const lesson = m[1].trim();
    if (lesson.length > 20 && !lesson.includes('{') && !lesson.includes('function')) {
      lessons.push({
        type: 'convention',
        text: lesson,
        confidence: 0.75,
      });
    }
  }

  // Pattern 5: Failed search patterns (agent should avoid these next time)
  // "grep returned no results for X"
  const failMatches = text.matchAll(/(?:no results|not found|failed to find)\s+(?:for\s+)?['"]?([^'".\n]{5,80})['"]?/gi);
  for (const m of failMatches) {
    const term = m[1].trim();
    if (term.length > 4) {
      lessons.push({
        type: 'avoid',
        text: `Search term '${term}' yielded no results — use skeletonizer instead`,
        confidence: 0.6,
      });
    }
  }

  // Pattern 6: Package/module relationships
  const packageMatches = text.matchAll(/(?:package|module)\s+['"]?([\w@/-]+)['"]?\s+(?:exports|provides|contains)\s+([^.\n]{10,100})/gi);
  for (const m of packageMatches) {
    lessons.push({
      type: 'module',
      text: `Package ${m[1].trim()} provides: ${m[2].trim()}`,
      confidence: 0.8,
    });
  }

  // Deduplicate within this session
  const seen = new Set();
  return lessons.filter(l => {
    const key = l.text.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Curator: remove lessons too similar to existing ones
// Uses simple TF-IDF cosine similarity (no external deps)
// ---------------------------------------------------------------------------
function curateLessons(newLessons, existingLessons) {
  const existingVectors = existingLessons.map(l => tfidf(l.text));

  return newLessons.filter(lesson => {
    const vec = tfidf(lesson.text);
    for (const existingVec of existingVectors) {
      if (cosineSimilarity(vec, existingVec) > SIMILARITY_THRESHOLD) {
        return false; // Too similar — skip
      }
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Simple TF-IDF vector (bag-of-words, term frequency only)
// ---------------------------------------------------------------------------
function tfidf(text) {
  const words = text.toLowerCase().match(/\b\w{3,}\b/g) ?? [];
  const freq = {};
  for (const w of words) {
    freq[w] = (freq[w] ?? 0) + 1;
  }
  return freq;
}

function cosineSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, magA = 0, magB = 0;

  for (const k of keys) {
    const av = a[k] ?? 0;
    const bv = b[k] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ---------------------------------------------------------------------------
// Playbook I/O
// ---------------------------------------------------------------------------
function findPlaybookPath(workspaceRoot) {
  // Prefer project-level GEMINI.md
  return resolve(workspaceRoot, PLAYBOOK_FILENAME);
}

async function loadPlaybook(path) {
  try {
    await access(path, constants.F_OK);
    return await readFile(path, 'utf-8');
  } catch {
    return buildInitialPlaybook();
  }
}

function parseExistingLessons(content) {
  const sectionStart = content.indexOf(LESSON_SECTION_HEADER);
  if (sectionStart === -1) return [];

  const sectionContent = content.slice(sectionStart + LESSON_SECTION_HEADER.length);
  const lessonMatches = sectionContent.matchAll(/^- \[(\w+)\] (.+)$/gm);
  const lessons = [];

  for (const m of lessonMatches) {
    lessons.push({ type: m[1], text: m[2] });
  }

  return lessons;
}

function buildPlaybookContent(existingContent, allLessons) {
  const timestamp = new Date().toISOString().split('T')[0];

  const lessonBlock = [
    LESSON_SECTION_HEADER,
    ``,
    `> Auto-generated by ACE Playbook. Last updated: ${timestamp}`,
    `> These strategies were learned from real agent sessions on this repository.`,
    ``,
    ...allLessons.map(l => `- [${l.type ?? 'general'}] ${l.text}`),
    ``,
  ].join('\n');

  // Replace existing lesson section or append
  const sectionStart = existingContent.indexOf(LESSON_SECTION_HEADER);
  if (sectionStart !== -1) {
    // Find end of section (next ## header or end of file)
    const afterSection = existingContent.slice(sectionStart + LESSON_SECTION_HEADER.length);
    const nextSection = afterSection.search(/\n## /);
    const endIdx = nextSection === -1
      ? existingContent.length
      : sectionStart + LESSON_SECTION_HEADER.length + nextSection;

    return existingContent.slice(0, sectionStart) + lessonBlock + existingContent.slice(endIdx);
  }

  // Append to end
  return existingContent.trimEnd() + '\n\n' + lessonBlock;
}

function buildInitialPlaybook() {
  return `# Rocket.Chat Code Analyzer — Project Playbook

## About This File
This file is automatically maintained by the ACE (Agentic Context Engineering)
system. It provides the AI agent with repository-specific strategies and patterns
discovered during previous sessions, eliminating redundant re-discovery costs.

## Repository Overview
- **Monorepo layout**: \`apps/\` (server/client), \`packages/\` (shared libs), \`ee/\` (enterprise)
- **Core server**: \`apps/meteor/app/\` — Meteor methods and business logic
- **UI system**: \`packages/fuselage/\` — React component library
- **Message parsing**: \`packages/message-parser/\` — PeggyJS grammar
- **Apps Engine**: \`packages/apps-engine/\` — plugin/app bridge architecture

## Tool Usage Guidelines
- Use \`read_file_skeleton\` FIRST before \`read_symbol_details\` — always navigate top-down
- Use \`list_files\` for initial discovery, never grep entire repo directories
- Meteor RPC calls (\`Meteor.call('name')\`) map to files in \`apps/meteor/server/methods/\`
- Path aliases (e.g., \`@rocket.chat/ui-kit\`) are resolved via \`tsconfig.json\` paths

## Known Patterns
- Server-side message logic: \`apps/meteor/app/lib/server/\`
- Client-side rooms: \`apps/meteor/client/views/room/\`
- REST API endpoints: \`apps/meteor/app/api/server/v1/\`
- Shared types: \`packages/core-typings/src/\`

`;
}

function log(msg) {
  process.stderr.write(`${msg}\n`);
}

main().catch(err => {
  log(`[ACEPlaybook] Fatal: ${err.message}`);
  process.exit(0); // Non-fatal — don't break the agent
});
