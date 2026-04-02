# PromptLine: Robust Hooks & Multi-Agent Redesign

**Date:** 2026-04-02
**Status:** Draft
**Author:** Juanchi + Claude

## Problem

PromptLine modifies the user's global Claude Code environment (`~/.claude/settings.json`, `~/.claude/hooks/`) in ways that are fragile:

- No `uninstall` command — hooks and copied files persist forever
- No protection against corrupting `settings.json` (no locking, no atomic writes)
- Users run 5-6 Claude instances in parallel → race conditions on settings.json
- Requires `python3` as a runtime dependency for hooks
- No support for other agents (Codex CLI uses the same hook contract)

## Goals

1. Robust `install`/`uninstall` CLI commands with atomic writes and file locking
2. Zero risk of corrupting the user's `settings.json`
3. Hooks reference scripts in-place from node_modules (no file copying)
4. Self-healing: dashboard validates hook integrity on every startup
5. Multi-agent support: same scripts work for Claude Code and Codex CLI
6. Remove `python3` dependency — shell + jq only
7. Everything that works today (dashboard, API, queue store) keeps working untouched

## Non-Goals

- Migrating to the Claude Code plugin system (requires marketplace, cache copies desync on npm update)
- Changing the dashboard UI or React architecture
- Changing the queue data format or file structure
- Supporting agents beyond Claude Code and Codex CLI

## Architecture

```
┌─────────────────────────────────────────────────┐
│              @jxtools/promptline                 │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ hooks/   │  │ src/     │  │ bin/          │  │
│  │ (shell)  │  │ (React + │  │ promptline.mjs│  │
│  │          │  │  API)    │  │               │  │
│  └────┬─────┘  └────┬─────┘  └──────┬────────┘  │
│       │              │               │           │
└───────┼──────────────┼───────────────┼───────────┘
        │              │               │
   Registered in:      │          CLI commands:
   ┌────┴────┐         │          install/uninstall
   │         │         │          status/update
   ▼         ▼         ▼
Claude    Codex     Dashboard
Code      CLI       (Vite)
hooks     hooks       │
   │         │         │
   └────┬────┘    REST + SSE
        │              │
        ▼              ▼
   ~/.promptline/queues/{project}/{session}.json
```

## Package Structure

```
@jxtools/promptline
├── bin/promptline.mjs              # CLI entry point
├── hooks/                          # Shell scripts (referenced in-place, never copied)
│   ├── stop-hook.sh
│   ├── session-start.sh
│   └── session-end.sh
├── src/                            # React dashboard + API + queue store (unchanged)
│   ├── main.tsx
│   ├── App.tsx
│   ├── api/client.ts
│   ├── backend/queue-store.ts
│   ├── components/
│   ├── hooks/
│   ├── types/
│   └── utils/
├── vite-plugin-api.ts
├── vite.config.ts
└── package.json
```

## CLI Commands

| Command | Action |
|---|---|
| `promptline` | Validate hooks → launch dashboard |
| `promptline install` | Register hooks in Claude Code settings.json |
| `promptline install --codex` | Register hooks in Codex hooks.json |
| `promptline uninstall` | Remove hooks from Claude Code + optionally delete queue data |
| `promptline uninstall --codex` | Remove hooks from Codex |
| `promptline status` | Show hook status, registered agents, active sessions |
| `promptline update` | Update npm package (existing behavior) |
| `promptline --version` | Print version |

## Install/Uninstall: Robust Settings Modification

### `promptline install` Flow

```
1.  Verify ~/.claude exists
2.  Resolve hook paths: pkgDir/hooks/*.sh (verify files exist on disk)
3.  Acquire exclusive flock on ~/.claude/settings.json.lock (timeout 5s)
4.  Read ~/.claude/settings.json
5.  If not valid JSON → abort, touch nothing, report error
6.  Create backup → ~/.claude/settings.json.bak.{timestamp}
7.  Minimal merge: add 3 hook entries under "hooks" key
8.  If entries already exist (idempotent) → update command paths only
9.  Write to settings.json.tmp.{pid} → atomic mv to settings.json
10. Re-read and validate JSON → if invalid, restore backup
11. Release flock
12. Clean old backups (keep last 3)
```

### `promptline uninstall` Flow

```
1. Acquire flock
2. Read settings.json
3. Create backup
4. Filter: remove entries whose command contains "@jxtools/promptline/hooks/"
5. Clean empty arrays (if Stop has no hooks left, remove the Stop key)
6. Atomic write + validation
7. Release flock
8. Prompt: "Delete queue data? (~/.promptline/queues/) [y/N]"
9. If legacy hooks found in ~/.claude/hooks/ → offer to clean them up
```

### Hook Identification

PromptLine hooks are identified by the string `@jxtools/promptline/hooks/` in the `command` field. This is how `uninstall` knows exactly which entries to remove without affecting user hooks.

Example settings.json after install:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash \"/Users/user/.nvm/.../lib/node_modules/@jxtools/promptline/hooks/stop-hook.sh\""
        }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash \"/Users/user/.nvm/.../lib/node_modules/@jxtools/promptline/hooks/session-start.sh\""
        }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{
          "type": "command",
          "command": "bash \"/Users/user/.nvm/.../lib/node_modules/@jxtools/promptline/hooks/session-end.sh\""
        }]
      }
    ]
  }
}
```

### Robustness Guarantees

| Scenario | Behavior |
|---|---|
| settings.json is corrupted JSON | Abort, touch nothing, report error |
| Another instance writing simultaneously | flock waits up to 5s, then fails cleanly |
| Crash during write | .tmp file left orphaned, original settings.json untouched |
| `install` run twice | Updates paths, does not duplicate entries |
| `uninstall` without prior install | No-op, reports "No PromptLine hooks found" |
| `npm update` changes package path | `promptline install` updates paths; dashboard warns if stale |
| nvm switch changes node version | Dashboard detects stale paths, prompts `promptline install` |

## Startup Validation

Every time `promptline` (dashboard) runs:

1. Verify `~/.claude` exists
2. Read settings.json, search for hooks containing `@jxtools/promptline/hooks/`
3. If no hooks found → warn: "Run `promptline install` first"
4. If hooks found but .sh files don't exist on disk → warn: "Hooks outdated, run `promptline install`"
5. If all OK → start Vite dev server

## Hooks: Shell-Only Implementation

All three hooks are rewritten from Python to shell + jq. Same logic, no python3 dependency.

### session-start.sh (SessionStart)

Receives JSON on stdin with `session_id`, `cwd`, `transcript_path`.
Creates or reopens `~/.promptline/queues/{project}/{session_id}.json`.

### stop-hook.sh (Stop)

Receives JSON on stdin with `session_id`, `cwd`, `transcript_path`, `stop_hook_active`.

1. Acquire file lock on `{session_id}.json.lock`
2. Read session JSON
3. Mark any `running` prompts as `completed`
4. Find first `pending` prompt
5. If none → release lock, exit 0 (silent — Claude stops normally)
6. If found → mark as `running`, set `currentPromptId`, write session JSON
7. Output: `{"decision":"block","reason":"<prompt text>"}`
8. Release lock

Additionally, when SessionEnd is not available (Codex): run opportunistic orphan sweep by checking `ownerPid` of other sessions.

### session-end.sh (SessionEnd)

Receives JSON on stdin with `session_id`.
Sets `closedAt`, cancels pending/running prompts, runs orphan sweep.

Note: Codex CLI does not have SessionEnd. Orphan cleanup is handled by stop-hook.sh and the dashboard startup.

## Multi-Agent Support

### Same scripts, different registration

The hook scripts are agent-agnostic. They read JSON from stdin, write JSON to stdout. The contract is identical between Claude Code and Codex CLI:

| Field | Claude Code | Codex CLI |
|---|---|---|
| stdin: `session_id` | Yes | Yes |
| stdin: `cwd` | Yes | Yes |
| stdin: `stop_hook_active` | Yes | Yes |
| stdout: `{"decision":"block","reason":"..."}` | Yes | Yes |

### Registration differs by agent

| Agent | Config file | Registration method |
|---|---|---|
| Claude Code | `~/.claude/settings.json` under `hooks` | `promptline install` |
| Codex CLI | `~/.codex/hooks.json` (global config dir) | `promptline install --codex` |

### SessionEnd gap in Codex

Codex has no SessionEnd event. Mitigation:

1. `stop-hook.sh` checks `ownerPid` of other sessions on each run — closes dead ones
2. Dashboard startup scans and closes orphaned sessions
3. Sessions with no activity for 24h and no live PID are auto-closed

## What Does NOT Change

- Dashboard React app (all components, hooks, styles)
- API REST + SSE endpoints (vite-plugin-api.ts)
- Queue store (src/backend/queue-store.ts) — locking, atomic writes, visibility
- Data structure (~/.promptline/queues/{project}/{session}.json schema)
- npm distribution (@jxtools/promptline, same CI/CD, same GitHub Actions)
- package.json bin field

## What Changes

| Component | From | To |
|---|---|---|
| Hook scripts | Python (.sh calling python3) | Shell + jq |
| Hook location | Copied to ~/.claude/hooks/ | Referenced in-place from node_modules |
| Hook registration | Automatic on every `promptline` run | Explicit `promptline install` |
| bin/install-hooks.mjs | Copies files + modifies settings.json | Removed. Replaced by install/uninstall in promptline.mjs |
| settings.json writes | No locking, no atomic write | flock + atomic write + backup + validation |
| python3 dependency | Required | Eliminated |
| Multi-agent | Claude Code only | Claude Code + Codex CLI |

## Migration Path for Existing Users

1. User updates to new version via `npm update -g @jxtools/promptline`
2. Runs `promptline` → does not detect new-format hooks in settings.json
3. Gets message: "Run `promptline install` to set up hooks"
4. Runs `promptline install` → new hooks registered in settings.json
5. Old scripts in `~/.claude/hooks/` remain but are not registered (harmless)
6. Old hook entries in settings.json pointing to `~/.claude/hooks/promptline-*` are detected and removed during install
7. Optional: `promptline uninstall` offers to clean legacy files from `~/.claude/hooks/`

## Safe Migration Order

```
1. Create hooks/ directory with shell+jq scripts (new code, breaks nothing)
2. Create install/uninstall logic with flock + atomic writes (new code)
3. Refactor bin/promptline.mjs to use new flow
4. Remove bin/install-hooks.mjs and root-level .sh files
5. Add --codex support
6. End-to-end testing
```
