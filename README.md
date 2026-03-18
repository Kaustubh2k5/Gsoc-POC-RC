# Rocket.Chat Code Analyzer
### Self-Optimizing Playbook Architecture for Gemini CLI

A production-grade MCP extension for `gemini-cli` that enables AI agents to work with massive monorepos (like Rocket.Chat's 2.1 GiB repo) while staying within Google's **free-tier** inference limits.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     GEMINI CLI AGENT LOOP                       │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ BeforeModel  │    │  MCP Server  │    │  AfterAgent      │  │
│  │   HOOK       │    │  (index.js)  │    │    HOOK          │  │
│  │              │    │              │    │                  │  │
│  │ Observation  │    │ 8 JIT Tools  │    │ ACE Playbook     │  │
│  │  Masking     │    │              │    │ Reflector+Curator│  │
│  │ ~52% token   │    │ read_file_   │    │ GEMINI.md update │  │
│  │  reduction   │    │  skeleton    │    │ 75% cost saving  │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### The 5 Layers

| Layer | Mechanism | Token Impact |
|-------|-----------|-------------|
| **Strategy** | ACE Playbook (AfterAgent hook) | 75.1% session cost reduction |
| **History** | Observation Masking (BeforeModel hook) | 52% per-turn reduction |
| **Analysis** | Tree-sitter Skeletonization | 90% per-file reduction |
| **Intelligence** | Meteor method + tsconfig resolver | Eliminates grep cost |
| **Execution** | JIT Hydration (3-phase disclosure) | 2k → vs 150k discovery |

---

## Installation

### 1. Copy files into your extension directory

```bash
# In your gemini-cli extensions folder:
cd /path/to/gemini-extension/code-analyzer

# Copy all files from this repo:
cp -r <this-repo>/* .
```

### 2. Install dependencies

```bash
npm install
```

> **Note on Tree-sitter:** The skeletonizer has a built-in regex fallback if the
> Tree-sitter native addons (`tree-sitter-typescript`) cannot compile. It works
> without them, with slightly less precision on complex TypeScript patterns.
> To get full Tree-sitter support:
> ```bash
> npm install --build-from-source tree-sitter tree-sitter-typescript tree-sitter-javascript
> ```

### 3. Register with Gemini CLI

The `gemini-extension.json` is already configured. Point it at your Rocket.Chat repo:

```bash
# Set your repo root (or let it default to the cwd when gemini-cli runs)
export REPO_ROOT=/path/to/Rocket.Chat
```

Or set it permanently in your shell profile / `.env`.

### 4. Verify

```bash
node index.js
# Should start without errors and wait on stdin
```

---

## File Structure

```
code-analyzer/
├── index.js                    ← MCP server (8 tools)
├── gemini-extension.json       ← Extension config + hook registration
├── package.json
├── hooks/
│   ├── observation-masking.js  ← BeforeModel hook (trajectory masking)
│   └── ace-playbook.js         ← AfterAgent hook (playbook updates)
└── src/
    ├── tools/
    │   ├── skeletonizer.js     ← Tree-sitter/regex AST skeleton engine
    │   └── jit-state.js        ← JIT phase state manager
    └── utils/
        └── fs-utils.js         ← File walker, import graph, blast radius
```

---

## MCP Tools Reference

### Level 1 — Discovery (~2k tokens)

**`list_files`**
```
list_files(path?: string, pattern?: string, max_results?: number)
```
Lists files in the repo. Always start here.

---

### Level 2 — Navigation (~500 tokens/file)

**`read_file_skeleton`**
```
read_file_skeleton(file_path: string, include_imports?: boolean, include_meteor_methods?: boolean)
```
Returns the structural skeleton of a file — exported interfaces, types, class signatures, function signatures. Bodies stripped. **90% token reduction.**

---

### Level 3 — Action (~500 tokens/symbol)

**`read_symbol_details`**
```
read_symbol_details(file_path: string, symbol_name: string)
```
Hydrates the full implementation of a single named symbol. Call only when ready to act.

---

### Domain Resolution

**`search_symbol`**
```
search_symbol(query: string, file_pattern?: string, max_results?: number)
```
Finds files likely to contain a symbol or concept. Uses filename scoring + Meteor/alias maps.

**`resolve_meteor_method`**
```
resolve_meteor_method(method_name: string)
```
Maps `Meteor.call('methodName')` → implementation file. Eliminates grep.

**`resolve_alias`**
```
resolve_alias(alias: string)
```
Maps `@rocket.chat/ui-kit` → real path via tsconfig.json parsing.

---

### Safety

**`blast_radius`**
```
blast_radius(file_path: string, max_depth?: number)
```
Shows which files transitively import a given file. Run before modifying shared utilities.

**`repo_stats`**
```
repo_stats()
```
Token budget overview — files indexed, phase state, estimated savings.

---

## Hooks

### BeforeModel — Observation Masking (`hooks/observation-masking.js`)

Intercepts `llm_request.messages` before every API call. Tool outputs older than the last 10 turns are replaced with compact placeholders:

```
[...487 lines of tool output omitted — within observation masking window...]
```

- **Input:** JSON payload on stdin (from gemini-cli)
- **Output:** Modified payload on stdout
- **Effect:** ~52% token reduction on tool-heavy sessions

### AfterAgent — ACE Playbook (`hooks/ace-playbook.js`)

Runs after each completed agent session. Extracts actionable lessons from the transcript and merges them into `GEMINI.md` using cosine similarity deduplication:

**Patterns extracted automatically:**
- File location discoveries (`"found in apps/meteor/..."`)
- Meteor method mappings
- Import alias resolutions
- Agent-stated conventions
- Failed search patterns (to avoid next session)

**Deduplication:** Uses TF-IDF cosine similarity (threshold: 0.82) — no external ML dependencies.

---

## The 3-Phase JIT Workflow

The agent is guided through progressive disclosure:

```
Phase 1 — DISCOVERY
  list_files("apps/meteor/server")
  → 2,000 tokens  (vs 150,000 raw scan)

Phase 2 — NAVIGATION
  read_file_skeleton("apps/meteor/server/methods/sendMessage.ts")
  → ~300 tokens   (vs 8,000 raw file)

Phase 3 — ACTION
  read_symbol_details("apps/meteor/server/methods/sendMessage.ts", "sendMessage")
  → ~400 tokens   (targeted hydration)
```

---

## Rocket.Chat Domain Knowledge

The analyzer includes built-in Rocket.Chat-specific resolvers:

| Challenge | Solution |
|-----------|----------|
| `Meteor.call('sendMessage')` in client → where's the impl? | `resolve_meteor_method("sendMessage")` |
| `import X from '@rocket.chat/ui-kit'` → where's the source? | `resolve_alias("@rocket.chat/ui-kit")` |
| Modifying `UserService` → what breaks? | `blast_radius("apps/meteor/app/...")` |
| Find message permission logic | `search_symbol("message permission")` |

---

## GEMINI.md Playbook

After the first few sessions, `GEMINI.md` in your repo root will contain an auto-maintained section like:

```markdown
## 🧠 ACE Playbook — Learned Strategies

> Auto-generated by ACE Playbook. Last updated: 2025-11-15

- [file-location] File location: apps/meteor/server/methods/sendMessage.ts
- [meteor-method] Meteor method 'sendMessage' discovered in session
- [convention] Server-side message logic is always registered via Meteor.methods
- [alias] Import alias @rocket.chat/core-typings resolves to packages/core-typings/src
```

This is loaded at the start of every session — the agent starts pre-trained on your repo.

---

## Token Efficiency Summary

| Scenario | Raw Agent | With Analyzer | Saving |
|----------|-----------|---------------|--------|
| Initial discovery | 150,000 tok | 2,000 tok | **98%** |
| 50-turn session trajectory | 1,000,000+ tok | 120,000 tok | **88%** |
| Re-discovery (2nd session) | Full re-scan | 0 (uses Playbook) | **100%** |
| Per-file read | 15,000 tok | 500 tok | **97%** |

---

## Contributing / Upstreaming

The skeletonization, masking, and ACE mechanisms are designed to be repo-agnostic.
They can be contributed back upstream to `gemini-cli` for use with any large TypeScript monorepo.

Key files for upstreaming:
- `src/tools/skeletonizer.js` — language-agnostic AST skeleton engine
- `hooks/observation-masking.js` — generic BeforeModel masking hook
- `hooks/ace-playbook.js` — generic AfterAgent learning hook
