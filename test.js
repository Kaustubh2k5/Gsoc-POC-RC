/**
 * Skeletonizer Test
 * Run from inside code-analyzer/:
 *   node test.js
 */

import { skeletonizeFile, extractSymbol } from './src/ts-engine/index.js';
import { writeFileSync, unlinkSync } from 'fs';

// =============================================================================
// Test fixtures — written to disk, skeletonized, then deleted
// =============================================================================

const TESTS = [

  // ── Test 1: Basic exports ─────────────────────────────────────────────────
  {
    name: 'Basic exports',
    ext: '.ts',
    src: `
import { z } from 'zod';
import { readFile } from 'fs/promises';

interface IUser {
  id: string;
  name: string;
}

export interface IMessage {
  rid: string;
  msg: string;
}

export async function sendMessage(msg: IMessage): Promise<boolean> {
  const result = await doSomething(msg);
  return result;
}

export class MessageService {
  private db: Database;
  public async send(msg: IMessage): Promise<void> { }
  static validate(msg: unknown): boolean { return true; }
}

export const MAX_LENGTH = 5000;
export type MessageStatus = 'sent' | 'pending' | 'failed';
`,
    expect: [
      "import { z }",
      "import { readFile }",
      "// ── Types",
      "interface IUser",          // bare type — should appear
      "// ── Exports",
      "export interface IMessage", // exported — should NOT appear in Types
      "export async function sendMessage",
      "export class MessageService",
      "public async send",
      "static validate",
      "export const MAX_LENGTH",
      "export type MessageStatus",
    ],
    notExpect: [
      // IMessage must NOT appear under Types (only under Exports)
    ],
  },

  // ── Test 2: MCP tool registrations (Shape A) ──────────────────────────────
  {
    name: 'MCP registrations (Shape A)',
    ext: '.js',
    src: `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'test', version: '1.0.0' });

server.registerTool(
  'list_files',
  {
    description: 'Lists files in the repository for discovery.',
    inputSchema: {
      path: z.string().optional(),
      pattern: z.string().optional(),
    }
  },
  async ({ path, pattern }) => {
    return { content: [] };
  }
);

server.registerTool(
  'read_skeleton',
  {
    description: 'Returns a lean skeleton of a file.',
    inputSchema: { file_path: z.string() }
  },
  async ({ file_path }) => {
    return { content: [] };
  }
);
`,
    expect: [
      "// ── Registrations",
      "server.registerTool('list_files'",
      "Lists files in the repository",
      "server.registerTool('read_skeleton'",
      "Returns a lean skeleton",
    ],
  },

  // ── Test 3: Meteor.methods (Shape B) ──────────────────────────────────────
  {
    name: 'Meteor.methods (Shape B)',
    ext: '.ts',
    src: `
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';

export interface ISendMessageOptions {
  rid: string;
  msg: string;
  tmid?: string;
}

Meteor.methods({
  async sendMessage(message: ISendMessageOptions) {
    check(message, Object);
    return doSend(message);
  },
  async deleteMessage(msgId: string) {
    check(msgId, String);
    return doDelete(msgId);
  },
});
`,
    expect: [
      "// ── Exports",
      "export interface ISendMessageOptions",
      "// ── Registrations",
      "Meteor.methods({",
      "async sendMessage",
      "async deleteMessage",
    ],
    notExpect: [
      // ISendMessageOptions must NOT appear in Types section
    ],
    checkMeteorMethods: ['sendMessage', 'deleteMessage'],
  },

  // ── Test 4: Symbol extraction ─────────────────────────────────────────────
  {
    name: 'Symbol extraction',
    ext: '.ts',
    src: `
import { db } from './db';

interface InternalConfig {
  timeout: number;
}

export async function validateMessage(msg: string): Promise<boolean> {
  if (!msg) return false;
  const result = await db.validate(msg);
  return result.ok;
}

export class RoomService {
  async joinRoom(roomId: string, userId: string): Promise<void> {
    await db.rooms.addMember(roomId, userId);
  }
}

export const helper = (x: number) => x * 2;
`,
    symbols: ['validateMessage', 'RoomService', 'helper'],
  },

  // ── Test 5: Fallback (token-stream) ───────────────────────────────────────
  {
    name: 'Token-stream fallback (pure JS, no TS syntax)',
    ext: '.js',
    src: `
import express from 'express';

const router = express.Router();

router.get('/rooms', async (req, res) => {
  const rooms = await getRooms();
  res.json(rooms);
});

router.post('/rooms', async (req, res) => {
  const room = await createRoom(req.body);
  res.json(room);
});

function getRooms() {
  return db.find({});
}
`,
    expect: [
      "// ── Registrations",
      "router.get('/rooms'",
      "router.post('/rooms'",
      "// ── Module-level",
      "function getRooms",
    ],
  },

];

// =============================================================================
// Runner
// =============================================================================

let passed = 0;
let failed = 0;

async function runTest(test) {
  const filePath = `/tmp/skel-test-${Date.now()}${test.ext}`;
  writeFileSync(filePath, test.src.trim(), 'utf-8');

  try {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`TEST: ${test.name}`);
    console.log('─'.repeat(60));

    const result = await skeletonizeFile(filePath);

    if (result.error) {
      console.log(`❌ ERROR: ${result.error}`);
      failed++;
      return;
    }

    console.log(`Engine : ${result.stats.engine}`);
    console.log(`Lines  : ${result.stats.originalLines} → ${result.stats.skeletonLines} (${result.stats.reductionPct}% reduction)`);
    console.log(`\nSkeleton:\n`);
    console.log(result.skeleton);

    // Check expected strings
    let testPassed = true;
    if (test.expect) {
      for (const str of test.expect) {
        if (!result.skeleton.includes(str)) {
          console.log(`\n❌ MISSING: "${str}"`);
          testPassed = false;
        }
      }
    }

    // Check strings that must NOT appear
    if (test.notExpect) {
      for (const str of test.notExpect) {
        if (result.skeleton.includes(str)) {
          console.log(`\n❌ SHOULD NOT CONTAIN: "${str}"`);
          testPassed = false;
        }
      }
    }

    // Check Meteor methods
    if (test.checkMeteorMethods) {
      console.log(`\nMeteor methods: ${JSON.stringify(result.meteorMethods)}`);
      for (const m of test.checkMeteorMethods) {
        if (!result.meteorMethods.includes(m)) {
          console.log(`❌ MISSING METEOR METHOD: "${m}"`);
          testPassed = false;
        }
      }
    }

    // Symbol extraction tests
    if (test.symbols) {
      console.log(`\nSymbol extraction:`);
      for (const sym of test.symbols) {
        const extracted = await extractSymbol(filePath, sym);
        if (!extracted.source) {
          console.log(`  ❌ "${sym}" — NOT FOUND (${extracted.error})`);
          testPassed = false;
        } else {
          console.log(`  ✅ "${sym}" — L${extracted.lineStart}–${extracted.lineEnd} (${extracted.engine})`);
          console.log(`     ${extracted.source.split('\n')[0].slice(0, 70)}`);
        }
      }
    }

    if (testPassed) {
      console.log(`\n✅ PASSED`);
      passed++;
    } else {
      failed++;
    }

  } finally {
    unlinkSync(filePath);
  }
}

// Run all tests
console.log('🧪 Skeletonizer Test Suite\n');

for (const test of TESTS) {
  await runTest(test);
}

console.log(`\n${'═'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${TESTS.length} tests`);
console.log('═'.repeat(60));

if (failed > 0) process.exit(1);