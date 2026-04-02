# Robust Hooks & Multi-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile Python-based hooks with robust shell+jq scripts, add explicit install/uninstall CLI commands with atomic settings.json writes, and support both Claude Code and Codex CLI.

**Architecture:** The npm package keeps its React dashboard + API untouched. Hook scripts move from root-level Python wrappers to `hooks/` directory as pure shell+jq. A new `bin/settings-manager.mjs` handles all settings.json operations with flock-based locking and atomic writes. The CLI (`bin/promptline.mjs`) gains `install`, `uninstall`, and `status` subcommands and validates hook integrity on every dashboard launch.

**Tech Stack:** Shell/Bash + jq (hooks), Node.js ESM (CLI/settings manager), React 19 + Vite 7 (dashboard, unchanged)

**Spec:** `docs/superpowers/specs/2026-04-02-robust-hooks-and-multi-agent-design.md`

---

## File Map

### New Files
| File | Responsibility |
|---|---|
| `bin/settings-manager.mjs` | All settings.json read/write operations with flock, atomic writes, backup, validation |
| `hooks/session-start.sh` | SessionStart hook — shell+jq, creates/reopens session JSON |
| `hooks/stop-hook.sh` | Stop hook — shell+jq, drains queue, outputs decision JSON |
| `hooks/session-end.sh` | SessionEnd hook — shell+jq, closes session, orphan sweep |

### Modified Files
| File | What Changes |
|---|---|
| `bin/promptline.mjs` | New subcommands (install/uninstall/status), startup validation, remove old installHooks call |
| `package.json` | Update `files` array (add `hooks/`, remove `promptline-*.sh`) |

### Deleted Files
| File | Why |
|---|---|
| `bin/install-hooks.mjs` | Replaced by `bin/settings-manager.mjs` |
| `promptline-session-register.sh` | Replaced by `hooks/session-start.sh` |
| `promptline-prompt-queue.sh` | Replaced by `hooks/stop-hook.sh` |
| `promptline-session-end.sh` | Replaced by `hooks/session-end.sh` |

---

## Task 1: Create `bin/settings-manager.mjs`

**Files:**
- Create: `bin/settings-manager.mjs`

This module handles ALL interactions with `~/.claude/settings.json` (and Codex `~/.codex/hooks.json`). Flock-based locking, atomic writes, backup/restore, idempotent merge/remove.

- [ ] **Step 1: Create `bin/settings-manager.mjs` with core utilities**

```js
// bin/settings-manager.mjs
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync, openSync, closeSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')

const HOOK_MARKER = '@jxtools/promptline/hooks/'
const LEGACY_MARKER = 'promptline-'
const MAX_BACKUPS = 3
const LOCK_TIMEOUT_MS = 5000
const LOCK_POLL_MS = 50

// --- File locking via flock(2) ---

function acquireLock(lockPath, timeoutMs = LOCK_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  mkdirSync(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      closeSync(fd)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      // Stale lock detection (>10s old)
      try {
        const { mtimeMs } = statSync(lockPath)
        if (Date.now() - mtimeMs > 10000) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        // Lock disappeared, retry
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timeout acquiring lock on ${lockPath} — another process may be writing settings`)
      }
      execFileSync('sleep', ['0.05'])
    }
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath) } catch {}
}

// --- Atomic JSON read/write ---

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`File is not valid JSON: ${filePath}`)
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch {}
    throw err
  }
}

function createBackup(filePath) {
  if (!existsSync(filePath)) return
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = `${filePath}.bak.${ts}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function cleanOldBackups(filePath) {
  const dir = dirname(filePath)
  const base = filePath.split('/').pop()
  const backups = readdirSync(dir)
    .filter(f => f.startsWith(`${base}.bak.`))
    .sort()
    .reverse()

  for (const old of backups.slice(MAX_BACKUPS)) {
    try { unlinkSync(join(dir, old)) } catch {}
  }
}

function validateJson(filePath) {
  const raw = readFileSync(filePath, 'utf-8')
  JSON.parse(raw) // throws if invalid
}

// --- Hook path resolution ---

export function resolveHookPaths() {
  const hooks = {
    SessionStart: resolve(pkgDir, 'hooks', 'session-start.sh'),
    Stop: resolve(pkgDir, 'hooks', 'stop-hook.sh'),
    SessionEnd: resolve(pkgDir, 'hooks', 'session-end.sh'),
  }

  const missing = Object.entries(hooks)
    .filter(([, path]) => !existsSync(path))
    .map(([event]) => event)

  if (missing.length > 0) {
    throw new Error(`Hook scripts not found for: ${missing.join(', ')}. Package may be corrupted.`)
  }

  return hooks
}

function buildHookCommand(scriptPath) {
  return `bash "${scriptPath}"`
}

// --- Claude Code: install/uninstall ---

function claudeSettingsPath() {
  return join(homedir(), '.claude', 'settings.json')
}

function claudeLockPath() {
  return join(homedir(), '.claude', 'settings.json.lock')
}

export function installClaude() {
  const claudeDir = join(homedir(), '.claude')
  if (!existsSync(claudeDir)) {
    throw new Error('Claude Code not found (~/.claude does not exist)')
  }

  const hookPaths = resolveHookPaths()
  const settingsPath = claudeSettingsPath()
  const lockPath = claudeLockPath()

  acquireLock(lockPath)
  try {
    const settings = readJsonSafe(settingsPath)
    createBackup(settingsPath)

    if (!settings.hooks) settings.hooks = {}

    // Remove legacy hooks (old format pointing to ~/.claude/hooks/promptline-*)
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] || []).filter(entry => {
        const cmds = (entry.hooks || []).map(h => h.command || '')
        return !cmds.some(c => c.includes(LEGACY_MARKER) && !c.includes(HOOK_MARKER))
      })
    }

    // Add or update promptline hooks
    for (const [event, scriptPath] of Object.entries(hookPaths)) {
      if (!settings.hooks[event]) settings.hooks[event] = []

      const command = buildHookCommand(scriptPath)
      const existingIdx = settings.hooks[event].findIndex(entry =>
        (entry.hooks || []).some(h => (h.command || '').includes(HOOK_MARKER))
      )

      const hookEntry = { hooks: [{ type: 'command', command }] }

      if (existingIdx >= 0) {
        settings.hooks[event][existingIdx] = hookEntry
      } else {
        settings.hooks[event].push(hookEntry)
      }
    }

    writeJsonAtomic(settingsPath, settings)

    // Post-write validation
    try {
      validateJson(settingsPath)
    } catch {
      // Restore backup
      const dir = dirname(settingsPath)
      const base = settingsPath.split('/').pop()
      const latestBackup = readdirSync(dir)
        .filter(f => f.startsWith(`${base}.bak.`))
        .sort()
        .pop()
      if (latestBackup) {
        renameSync(join(dir, latestBackup), settingsPath)
      }
      throw new Error('settings.json validation failed after write — restored from backup')
    }

    cleanOldBackups(settingsPath)
  } finally {
    releaseLock(lockPath)
  }
}

export function uninstallClaude() {
  const settingsPath = claudeSettingsPath()
  if (!existsSync(settingsPath)) {
    return { removed: false, message: 'No settings.json found' }
  }

  const lockPath = claudeLockPath()
  acquireLock(lockPath)
  try {
    const settings = readJsonSafe(settingsPath)
    if (!settings.hooks) {
      return { removed: false, message: 'No PromptLine hooks found' }
    }

    createBackup(settingsPath)

    let removedAny = false
    for (const event of Object.keys(settings.hooks)) {
      const before = settings.hooks[event].length
      settings.hooks[event] = settings.hooks[event].filter(entry => {
        const cmds = (entry.hooks || []).map(h => h.command || '')
        return !cmds.some(c => c.includes(HOOK_MARKER) || (c.includes(LEGACY_MARKER) && c.includes('promptline')))
      })
      if (settings.hooks[event].length < before) removedAny = true
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }

    if (Object.keys(settings.hooks).length === 0) delete settings.hooks

    if (!removedAny) {
      return { removed: false, message: 'No PromptLine hooks found' }
    }

    writeJsonAtomic(settingsPath, settings)
    validateJson(settingsPath)
    cleanOldBackups(settingsPath)

    return { removed: true, message: 'PromptLine hooks removed from Claude Code' }
  } finally {
    releaseLock(lockPath)
  }
}

// --- Codex: install/uninstall ---

function codexHooksPath() {
  return join(homedir(), '.codex', 'hooks.json')
}

function codexLockPath() {
  return join(homedir(), '.codex', 'hooks.json.lock')
}

export function installCodex() {
  const codexDir = join(homedir(), '.codex')
  mkdirSync(codexDir, { recursive: true })

  // Codex only supports: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop
  // No SessionEnd — orphan cleanup handled by stop-hook.sh
  const hookPaths = resolveHookPaths()
  const codexHooks = {
    SessionStart: hookPaths.SessionStart,
    Stop: hookPaths.Stop,
    // SessionEnd not available in Codex
  }

  const hooksPath = codexHooksPath()
  const lockPath = codexLockPath()

  acquireLock(lockPath)
  try {
    const config = readJsonSafe(hooksPath)
    createBackup(hooksPath)

    if (!config.hooks) config.hooks = {}

    for (const [event, scriptPath] of Object.entries(codexHooks)) {
      if (!config.hooks[event]) config.hooks[event] = []

      const command = buildHookCommand(scriptPath)
      const existingIdx = config.hooks[event].findIndex(entry =>
        (entry.hooks || []).some(h => (h.command || '').includes(HOOK_MARKER))
      )

      const hookEntry = { hooks: [{ type: 'command', command }] }

      if (existingIdx >= 0) {
        config.hooks[event][existingIdx] = hookEntry
      } else {
        config.hooks[event].push(hookEntry)
      }
    }

    writeJsonAtomic(hooksPath, config)
    validateJson(hooksPath)
    cleanOldBackups(hooksPath)
  } finally {
    releaseLock(lockPath)
  }
}

export function uninstallCodex() {
  const hooksPath = codexHooksPath()
  if (!existsSync(hooksPath)) {
    return { removed: false, message: 'No Codex hooks.json found' }
  }

  const lockPath = codexLockPath()
  acquireLock(lockPath)
  try {
    const config = readJsonSafe(hooksPath)
    if (!config.hooks) {
      return { removed: false, message: 'No PromptLine hooks found in Codex' }
    }

    createBackup(hooksPath)

    let removedAny = false
    for (const event of Object.keys(config.hooks)) {
      const before = config.hooks[event].length
      config.hooks[event] = config.hooks[event].filter(entry => {
        const cmds = (entry.hooks || []).map(h => h.command || '')
        return !cmds.some(c => c.includes(HOOK_MARKER))
      })
      if (config.hooks[event].length < before) removedAny = true
      if (config.hooks[event].length === 0) delete config.hooks[event]
    }

    if (Object.keys(config.hooks).length === 0) delete config.hooks

    if (!removedAny) {
      return { removed: false, message: 'No PromptLine hooks found in Codex' }
    }

    writeJsonAtomic(hooksPath, config)
    validateJson(hooksPath)
    cleanOldBackups(hooksPath)

    return { removed: true, message: 'PromptLine hooks removed from Codex' }
  } finally {
    releaseLock(lockPath)
  }
}

// --- Status / Validation ---

export function getStatus() {
  const result = { claude: null, codex: null, hookPaths: null }

  // Check hook scripts exist
  try {
    result.hookPaths = resolveHookPaths()
  } catch {
    result.hookPaths = null
  }

  // Claude Code
  const settingsPath = claudeSettingsPath()
  if (existsSync(settingsPath)) {
    try {
      const settings = readJsonSafe(settingsPath)
      const hooks = settings.hooks || {}
      const registered = []
      for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
        const entries = hooks[event] || []
        const found = entries.some(entry =>
          (entry.hooks || []).some(h => (h.command || '').includes(HOOK_MARKER))
        )
        if (found) registered.push(event)
      }
      result.claude = {
        installed: registered.length > 0,
        events: registered,
        pathsValid: registered.length > 0 && result.hookPaths !== null,
      }
    } catch {
      result.claude = { installed: false, events: [], pathsValid: false, error: 'settings.json unreadable' }
    }
  }

  // Codex
  const codexPath = codexHooksPath()
  if (existsSync(codexPath)) {
    try {
      const config = readJsonSafe(codexPath)
      const hooks = config.hooks || {}
      const registered = []
      for (const event of ['SessionStart', 'Stop']) {
        const entries = hooks[event] || []
        const found = entries.some(entry =>
          (entry.hooks || []).some(h => (h.command || '').includes(HOOK_MARKER))
        )
        if (found) registered.push(event)
      }
      result.codex = {
        installed: registered.length > 0,
        events: registered,
        pathsValid: registered.length > 0 && result.hookPaths !== null,
      }
    } catch {
      result.codex = { installed: false, events: [], pathsValid: false }
    }
  }

  return result
}

// --- Legacy cleanup ---

export function findLegacyHookFiles() {
  const legacyDir = join(homedir(), '.claude', 'hooks')
  if (!existsSync(legacyDir)) return []

  return readdirSync(legacyDir)
    .filter(f => f.startsWith('promptline-') && f.endsWith('.sh'))
    .map(f => join(legacyDir, f))
}

export function removeLegacyHookFiles(files) {
  for (const f of files) {
    try { unlinkSync(f) } catch {}
  }
}

export function toErrorMessage(error, fallback = 'Unknown error') {
  return error instanceof Error && error.message ? error.message : fallback
}
```

- [ ] **Step 2: Add missing import**

The `acquireLock` function uses `statSync` but it's not imported. Add it to the import:

Change the first import line from:
```js
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync, openSync, closeSync, mkdirSync } from 'node:fs'
```
to:
```js
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, readdirSync, openSync, closeSync, mkdirSync, statSync } from 'node:fs'
```

- [ ] **Step 3: Verify the module loads without errors**

Run: `cd /Users/juanchirossi/Documents/Proyectos/promptline && node -e "import('./bin/settings-manager.mjs').then(m => console.log('OK:', Object.keys(m).join(', ')))" --input-type=module`

Expected: `OK: resolveHookPaths, installClaude, uninstallClaude, installCodex, uninstallCodex, getStatus, findLegacyHookFiles, removeLegacyHookFiles, toErrorMessage`

- [ ] **Step 4: Commit**

```bash
git add bin/settings-manager.mjs
git commit -m "feat: add settings-manager with flock-based atomic settings.json writes"
```

---

## Task 2: Create `hooks/session-start.sh` (shell+jq)

**Files:**
- Create: `hooks/session-start.sh`

Port `promptline-session-register.sh` from Python to pure shell+jq. Same logic, same JSON schema, no python3.

- [ ] **Step 1: Create `hooks/session-start.sh`**

```bash
#!/bin/bash
# session-start.sh — SessionStart hook for PromptLine.
# Creates or reopens ~/.promptline/queues/{project}/{session_id}.json
set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

OWNER_PID="${PPID:-}"
OWNER_STARTED_AT=""
if [ -n "$OWNER_PID" ]; then
  OWNER_STARTED_AT=$(ps -p "$OWNER_PID" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
fi

QUEUES_BASE="$HOME/.promptline/queues"

# Search for existing session across all projects
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "$SESSION_ID.json" -print -quit 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
  QUEUE_FILE="$EXISTING"
  QUEUE_DIR="$(dirname "$EXISTING")"
else
  PROJECT=$(basename "$CWD")
  QUEUE_DIR="$QUEUES_BASE/$PROJECT"
  QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"
  mkdir -p "$QUEUE_DIR"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

# Extract session name from transcript's first user message
extract_session_name() {
  local tp="$1"
  [ -z "$tp" ] || [ ! -f "$tp" ] && return 0

  # Read line by line looking for first user message
  while IFS= read -r line; do
    local msg_type
    msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue
    [ "$msg_type" != "user" ] && continue

    # Try string content first
    local text
    text=$(echo "$line" | jq -r '
      .message.content
      | if type == "string" then . 
        elif type == "array" then [.[] | select(.type == "text") | .text] | first // empty
        else empty
      end
    ' 2>/dev/null) || continue

    [ -z "$text" ] && continue

    # Clean up and truncate
    text=$(echo "$text" | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ ${#text} -gt 50 ]; then
      echo "${text:0:50}..."
    else
      echo "$text"
    fi
    return 0
  done < "$tp"
}

SESSION_NAME=$(extract_session_name "$TRANSCRIPT_PATH")

atomic_write() {
  local target="$1" content="$2"
  local tmp_file="${target}.tmp.$$"
  echo "$content" > "$tmp_file"
  mv -f "$tmp_file" "$target"
}

if [ -f "$QUEUE_FILE" ]; then
  # Reopen existing session
  UPDATED=$(jq \
    --arg now "$NOW" \
    --arg pid "$OWNER_PID" \
    --arg started "$OWNER_STARTED_AT" \
    --arg name "$SESSION_NAME" \
    '
    .lastActivity = $now
    | .closedAt = null
    | if (.sessionName == null or .sessionName == "") and $name != "" then .sessionName = $name else . end
    | if ($pid | length) > 0 then .ownerPid = ($pid | tonumber) else . end
    | if ($started | length) > 0 then .ownerStartedAt = $started else . end
    ' "$QUEUE_FILE")
  atomic_write "$QUEUE_FILE" "$UPDATED"
else
  # Create new session
  PROJECT=$(basename "$CWD")
  NEW_SESSION=$(jq -n \
    --arg sid "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg dir "$CWD" \
    --arg name "$SESSION_NAME" \
    --arg now "$NOW" \
    --arg pid "$OWNER_PID" \
    --arg started "$OWNER_STARTED_AT" \
    '{
      sessionId: $sid,
      project: $project,
      directory: $dir,
      sessionName: (if $name == "" then null else $name end),
      prompts: [],
      startedAt: $now,
      lastActivity: $now,
      currentPromptId: null,
      completedAt: null,
      closedAt: null,
      ownerPid: (if ($pid | length) > 0 then ($pid | tonumber) else null end),
      ownerStartedAt: (if ($started | length) > 0 then $started else null end)
    }')
  atomic_write "$QUEUE_FILE" "$NEW_SESSION"
fi

exit 0
```

- [ ] **Step 2: Make executable and verify syntax**

Run: `chmod 755 hooks/session-start.sh && bash -n hooks/session-start.sh && echo "Syntax OK"`

Expected: `Syntax OK`

- [ ] **Step 3: Test with mock input**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
echo '{"session_id":"test-sess-001","cwd":"/tmp/testproject","transcript_path":""}' | bash hooks/session-start.sh
cat ~/.promptline/queues/testproject/test-sess-001.json | jq '.sessionId, .project, .closedAt'
```

Expected:
```
"test-sess-001"
"testproject"
null
```

- [ ] **Step 4: Clean up test file and commit**

```bash
rm -f ~/.promptline/queues/testproject/test-sess-001.json
rmdir ~/.promptline/queues/testproject 2>/dev/null || true
git add hooks/session-start.sh
git commit -m "feat: add session-start hook in shell+jq (replaces Python)"
```

---

## Task 3: Create `hooks/stop-hook.sh` (shell+jq)

**Files:**
- Create: `hooks/stop-hook.sh`

Port `promptline-prompt-queue.sh` from Python to pure shell+jq. This is the most complex hook — it drains the queue, handles locking, and outputs the decision JSON.

- [ ] **Step 1: Create `hooks/stop-hook.sh`**

```bash
#!/bin/bash
# stop-hook.sh — Stop hook for PromptLine.
# Drains the prompt queue: marks running→completed, takes next pending,
# outputs {"decision":"block","reason":"..."} or exits silently.
set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

if [ -z "$CWD" ]; then
  exit 0
fi

QUEUES_BASE="$HOME/.promptline/queues"

# Find session file
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "$SESSION_ID.json" -print -quit 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
  QUEUE_FILE="$EXISTING"
  QUEUE_DIR="$(dirname "$EXISTING")"
else
  PROJECT=$(basename "$CWD")
  QUEUE_DIR="$QUEUES_BASE/$PROJECT"
  QUEUE_FILE="$QUEUE_DIR/$SESSION_ID.json"
  mkdir -p "$QUEUE_DIR"
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
LOCK_FILE="${QUEUE_FILE}.lock"

# --- File locking ---
acquire_lock() {
  local lock="$1" deadline
  deadline=$(( $(date +%s) + 3 ))
  while true; do
    if (set -C; echo $$ > "$lock") 2>/dev/null; then
      return 0
    fi
    # Stale lock detection (>10s)
    if [ -f "$lock" ]; then
      local age
      age=$(( $(date +%s) - $(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || echo 0) ))
      if [ "$age" -gt 10 ]; then
        rm -f "$lock"
        continue
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      rm -f "$lock"
      return 0
    fi
    sleep 0.01
  done
}

release_lock() {
  rm -f "$1"
}

atomic_write() {
  local target="$1" content="$2"
  local tmp_file="${target}.tmp.$$"
  echo "$content" > "$tmp_file"
  mv -f "$tmp_file" "$target"
}

# Extract session name from transcript
extract_session_name() {
  local tp="$1"
  [ -z "$tp" ] || [ ! -f "$tp" ] && return 0
  while IFS= read -r line; do
    local msg_type
    msg_type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null) || continue
    [ "$msg_type" != "user" ] && continue
    local text
    text=$(echo "$line" | jq -r '
      .message.content
      | if type == "string" then .
        elif type == "array" then [.[] | select(.type == "text") | .text] | first // empty
        else empty
      end
    ' 2>/dev/null) || continue
    [ -z "$text" ] && continue
    text=$(echo "$text" | tr '\n' ' ' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    if [ ${#text} -gt 50 ]; then
      echo "${text:0:50}..."
    else
      echo "$text"
    fi
    return 0
  done < "$tp"
}

# --- Main logic ---
acquire_lock "$LOCK_FILE"
trap 'release_lock "$LOCK_FILE"' EXIT

# If session file doesn't exist, create it and stop
if [ ! -f "$QUEUE_FILE" ]; then
  PROJECT=$(basename "$CWD")
  SESSION_NAME=$(extract_session_name "$TRANSCRIPT_PATH")
  NEW_SESSION=$(jq -n \
    --arg sid "$SESSION_ID" \
    --arg project "$PROJECT" \
    --arg dir "$CWD" \
    --arg name "$SESSION_NAME" \
    --arg now "$NOW" \
    '{
      sessionId: $sid,
      project: $project,
      directory: $dir,
      sessionName: (if $name == "" then null else $name end),
      prompts: [],
      startedAt: $now,
      lastActivity: $now,
      currentPromptId: null,
      completedAt: null,
      closedAt: null,
      ownerPid: null,
      ownerStartedAt: null
    }')
  atomic_write "$QUEUE_FILE" "$NEW_SESSION"
  exit 0
fi

# Read and process queue
DATA=$(cat "$QUEUE_FILE")

# Validate JSON
if ! echo "$DATA" | jq empty 2>/dev/null; then
  exit 0
fi

SESSION_NAME_CURRENT=$(echo "$DATA" | jq -r '.sessionName // empty')

# Update session name if still null
EXTRA_NAME=""
if [ -z "$SESSION_NAME_CURRENT" ]; then
  EXTRA_NAME=$(extract_session_name "$TRANSCRIPT_PATH")
fi

# Process prompts: mark running→completed, find next pending, update state
RESULT=$(echo "$DATA" | jq -c \
  --arg now "$NOW" \
  --arg name "$EXTRA_NAME" \
  '
  # Mark running prompts as completed
  .prompts = [.prompts[] |
    if .status == "running" then
      .status = "completed" | .completedAt = $now
    else . end
  ]

  # Update sessionName if needed
  | if (.sessionName == null or .sessionName == "") and $name != "" then .sessionName = $name else . end

  # Check if all done
  | if (.prompts | length) > 0 and (.prompts | all(.status == "completed" or .status == "cancelled")) and .completedAt == null then
      .completedAt = $now
    else . end

  # Find first pending prompt
  | (.prompts | map(select(.status == "pending")) | first) as $next

  | if $next == null then
      # No pending prompts — stop
      .currentPromptId = null
      | .lastActivity = $now
      | { action: "stop", data: . }
    else
      # Mark next as running
      .prompts = [.prompts[] |
        if .id == $next.id then .status = "running" else . end
      ]
      | .currentPromptId = $next.id
      | .lastActivity = $now
      | (.prompts | map(select(.status == "pending")) | length) as $remaining
      | { action: "continue", data: ., promptText: $next.text, remaining: $remaining }
    end
  ')

ACTION=$(echo "$RESULT" | jq -r '.action')
UPDATED_DATA=$(echo "$RESULT" | jq '.data')

atomic_write "$QUEUE_FILE" "$UPDATED_DATA"

if [ "$ACTION" = "continue" ]; then
  PROMPT_TEXT=$(echo "$RESULT" | jq -r '.promptText')
  REMAINING=$(echo "$RESULT" | jq -r '.remaining')
  jq -n \
    --arg reason "PromptLine ($REMAINING queued)

$PROMPT_TEXT" \
    '{ decision: "block", reason: $reason }'
fi

exit 0
```

- [ ] **Step 2: Make executable and verify syntax**

Run: `chmod 755 hooks/stop-hook.sh && bash -n hooks/stop-hook.sh && echo "Syntax OK"`

Expected: `Syntax OK`

- [ ] **Step 3: Test stop with no queue (should exit silently)**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
mkdir -p ~/.promptline/queues/testproject
echo '{"sessionId":"test-stop","project":"testproject","directory":"/tmp","sessionName":null,"prompts":[],"startedAt":"2026-04-02T00:00:00.000Z","lastActivity":"2026-04-02T00:00:00.000Z","currentPromptId":null,"completedAt":null,"closedAt":null,"ownerPid":null,"ownerStartedAt":null}' > ~/.promptline/queues/testproject/test-stop.json
OUTPUT=$(echo '{"session_id":"test-stop","cwd":"/tmp/testproject","transcript_path":"","stop_hook_active":false}' | bash hooks/stop-hook.sh)
echo "Output: '$OUTPUT'"
```

Expected: `Output: ''` (empty — no pending prompts, Claude stops normally)

- [ ] **Step 4: Test stop with a pending prompt**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
echo '{"sessionId":"test-stop","project":"testproject","directory":"/tmp","sessionName":null,"prompts":[{"id":"p1","text":"Run the tests","status":"pending","createdAt":"2026-04-02T00:00:00.000Z"}],"startedAt":"2026-04-02T00:00:00.000Z","lastActivity":"2026-04-02T00:00:00.000Z","currentPromptId":null,"completedAt":null,"closedAt":null,"ownerPid":null,"ownerStartedAt":null}' > ~/.promptline/queues/testproject/test-stop.json
echo '{"session_id":"test-stop","cwd":"/tmp/testproject","transcript_path":"","stop_hook_active":false}' | bash hooks/stop-hook.sh
```

Expected output (JSON):
```json
{
  "decision": "block",
  "reason": "PromptLine (0 queued)\n\nRun the tests"
}
```

- [ ] **Step 5: Clean up test files and commit**

```bash
rm -f ~/.promptline/queues/testproject/test-stop.json
rm -f ~/.promptline/queues/testproject/test-stop.json.lock
rmdir ~/.promptline/queues/testproject 2>/dev/null || true
git add hooks/stop-hook.sh
git commit -m "feat: add stop-hook in shell+jq (replaces Python)"
```

---

## Task 4: Create `hooks/session-end.sh` (shell+jq)

**Files:**
- Create: `hooks/session-end.sh`

Port `promptline-session-end.sh` from Python to pure shell+jq. Handles session closure and orphan sweep.

- [ ] **Step 1: Create `hooks/session-end.sh`**

```bash
#!/bin/bash
# session-end.sh — SessionEnd hook for PromptLine.
# Closes the session, cancels pending/running prompts, sweeps orphaned sessions.
set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

if [ -z "$CWD" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

QUEUES_BASE="$HOME/.promptline/queues"

# Find session file
EXISTING=$(find "$QUEUES_BASE" -maxdepth 2 -name "$SESSION_ID.json" -print -quit 2>/dev/null || true)

if [ -z "$EXISTING" ]; then
  exit 0
fi

QUEUE_FILE="$EXISTING"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

atomic_write() {
  local target="$1" content="$2"
  local tmp_file="${target}.tmp.$$"
  echo "$content" > "$tmp_file"
  mv -f "$tmp_file" "$target"
}

close_session() {
  local file="$1"
  [ ! -f "$file" ] && return 0

  local data
  data=$(cat "$file") || return 0
  echo "$data" | jq empty 2>/dev/null || return 0

  local updated
  updated=$(echo "$data" | jq \
    --arg now "$NOW" \
    '
    .closedAt = $now
    | .lastActivity = $now
    | .ownerPid = null
    | .ownerStartedAt = null
    | .prompts = [.prompts[] |
        if .status == "pending" or .status == "running" then
          .status = "cancelled" | .completedAt = $now
        else . end
      ]
    ')
  atomic_write "$file" "$updated"
}

# Close current session
close_session "$QUEUE_FILE"

# --- Orphan sweep ---
# Check all other sessions across all projects.
# Close any whose ownerPid is dead or that have no PID info and are stale (24h).

LEGACY_TTL=86400  # 24 hours in seconds

is_process_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

for project_dir in "$QUEUES_BASE"/*/; do
  [ ! -d "$project_dir" ] && continue
  for session_file in "$project_dir"*.json; do
    [ ! -f "$session_file" ] && continue
    # Skip current session and lock files
    [ "$session_file" = "$QUEUE_FILE" ] && continue
    echo "$session_file" | grep -q '\.lock$\|\.tmp\.' && continue

    data=$(cat "$session_file" 2>/dev/null) || continue
    echo "$data" | jq empty 2>/dev/null || continue

    # Skip already closed
    closed=$(echo "$data" | jq -r '.closedAt // empty')
    [ -n "$closed" ] && continue

    # Check ownerPid
    owner_pid=$(echo "$data" | jq -r '.ownerPid // empty')
    owner_started=$(echo "$data" | jq -r '.ownerStartedAt // empty')

    if [ -n "$owner_pid" ] && [ "$owner_pid" != "null" ]; then
      # Has PID — check if alive
      if is_process_alive "$owner_pid"; then
        # PID alive — verify start time matches
        if [ -n "$owner_started" ] && [ "$owner_started" != "null" ]; then
          actual_started=$(ps -p "$owner_pid" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//' || true)
          if [ -n "$actual_started" ] && [ "$actual_started" = "$owner_started" ]; then
            continue  # Same process, still alive
          fi
          # Different process reused the PID — close as orphan
        else
          continue  # Alive, no start time to verify
        fi
      fi
      # PID dead or mismatched — close
      close_session "$session_file"
    else
      # No PID info (legacy session) — check staleness
      last_activity=$(echo "$data" | jq -r '.lastActivity // .startedAt // empty')
      if [ -n "$last_activity" ]; then
        # Convert ISO date to epoch (macOS compatible)
        activity_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${last_activity%%.*}" +%s 2>/dev/null || \
                         date -d "${last_activity}" +%s 2>/dev/null || echo 0)
        now_epoch=$(date +%s)
        age=$(( now_epoch - activity_epoch ))
        if [ "$age" -ge "$LEGACY_TTL" ]; then
          close_session "$session_file"
        fi
      fi
    fi
  done
done

exit 0
```

- [ ] **Step 2: Make executable and verify syntax**

Run: `chmod 755 hooks/session-end.sh && bash -n hooks/session-end.sh && echo "Syntax OK"`

Expected: `Syntax OK`

- [ ] **Step 3: Test session end closes session and cancels prompts**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
mkdir -p ~/.promptline/queues/testproject
echo '{"sessionId":"test-end","project":"testproject","directory":"/tmp","sessionName":"test","prompts":[{"id":"p1","text":"Do something","status":"pending","createdAt":"2026-04-02T00:00:00.000Z"}],"startedAt":"2026-04-02T00:00:00.000Z","lastActivity":"2026-04-02T00:00:00.000Z","currentPromptId":null,"completedAt":null,"closedAt":null,"ownerPid":null,"ownerStartedAt":null}' > ~/.promptline/queues/testproject/test-end.json
echo '{"session_id":"test-end","cwd":"/tmp/testproject"}' | bash hooks/session-end.sh
cat ~/.promptline/queues/testproject/test-end.json | jq '{closedAt: .closedAt, promptStatus: .prompts[0].status}'
```

Expected:
```json
{
  "closedAt": "2026-04-02T...",
  "promptStatus": "cancelled"
}
```

- [ ] **Step 4: Clean up and commit**

```bash
rm -f ~/.promptline/queues/testproject/test-end.json
rmdir ~/.promptline/queues/testproject 2>/dev/null || true
git add hooks/session-end.sh
git commit -m "feat: add session-end hook in shell+jq (replaces Python)"
```

---

## Task 5: Refactor `bin/promptline.mjs`

**Files:**
- Modify: `bin/promptline.mjs`

Add `install`, `uninstall`, `status` subcommands. Replace automatic hook installation with startup validation. Remove dependency on `bin/install-hooks.mjs`.

- [ ] **Step 1: Rewrite `bin/promptline.mjs`**

Replace the entire file content with:

```js
#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execFileSync } from 'child_process'
import { homedir } from 'os'
import { createInterface } from 'readline'
import {
  installClaude,
  uninstallClaude,
  installCodex,
  uninstallCodex,
  getStatus,
  findLegacyHookFiles,
  removeLegacyHookFiles,
  toErrorMessage,
} from './settings-manager.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
const registryFile = resolve(pkgDir, '.npm-registry')

// --- Utilities ---

function savedRegistry() {
  if (!existsSync(registryFile)) return ''
  return readFileSync(registryFile, 'utf-8').trim()
}

function npmRegistry() {
  const explicit = process.env.npm_config_registry || process.env.NPM_CONFIG_REGISTRY
  if (explicit) return explicit
  const saved = savedRegistry()
  if (saved) return saved
  try {
    return execFileSync('npm', ['config', 'get', 'registry'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function versionKey(version) {
  return version.replace(/^v/, '').split('.').map(part => part.padStart(6, '0')).join('')
}

function isNewerVersion(candidate, current) {
  return versionKey(candidate) > versionKey(current)
}

function npmViewLatestVersion(registry) {
  const args = ['view', '@jxtools/promptline', 'version']
  if (registry) args.push('--registry', registry)
  return execFileSync('npm', args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000' },
  }).trim()
}

function npmInstallLatest(registry) {
  const args = ['install', '-g', '@jxtools/promptline@latest']
  if (registry) args.push('--registry', registry)
  execFileSync('npm', args, {
    stdio: 'inherit',
    env: { ...process.env, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '10000' },
  })
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer) }))
}

// --- Commands ---

// --version
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`promptline v${pkg.version}`)
  process.exit(0)
}

const command = process.argv[2]
const flags = process.argv.slice(3)
const isCodex = flags.includes('--codex')

// install
if (command === 'install') {
  try {
    if (isCodex) {
      installCodex()
      console.log(`\x1b[32m✓\x1b[0m PromptLine hooks installed for Codex CLI`)
    } else {
      installClaude()
      console.log(`\x1b[32m✓\x1b[0m PromptLine hooks installed for Claude Code`)
    }

    // Offer to clean legacy hooks
    const legacyFiles = findLegacyHookFiles()
    if (legacyFiles.length > 0) {
      console.log(`\n\x1b[33m!\x1b[0m Found ${legacyFiles.length} legacy hook file(s) in ~/.claude/hooks/`)
      const answer = await ask('  Remove them? [y/N] ')
      if (answer.toLowerCase() === 'y') {
        removeLegacyHookFiles(legacyFiles)
        console.log(`\x1b[32m✓\x1b[0m Legacy hooks removed`)
      }
    }
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m ${toErrorMessage(err)}`)
    process.exit(1)
  }
  process.exit(0)
}

// uninstall
if (command === 'uninstall') {
  try {
    const result = isCodex ? uninstallCodex() : uninstallClaude()
    if (result.removed) {
      console.log(`\x1b[32m✓\x1b[0m ${result.message}`)

      const queuesDir = join(homedir(), '.promptline', 'queues')
      if (existsSync(queuesDir)) {
        const answer = await ask('  Delete queue data? (~/.promptline/queues/) [y/N] ')
        if (answer.toLowerCase() === 'y') {
          execFileSync('rm', ['-rf', queuesDir])
          console.log(`\x1b[32m✓\x1b[0m Queue data deleted`)
        }
      }
    } else {
      console.log(`\x1b[33m!\x1b[0m ${result.message}`)
    }
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m ${toErrorMessage(err)}`)
    process.exit(1)
  }
  process.exit(0)
}

// status
if (command === 'status') {
  const status = getStatus()

  console.log(`\x1b[36mPromptLine v${pkg.version}\x1b[0m\n`)

  // Hook scripts
  if (status.hookPaths) {
    console.log(`\x1b[32m✓\x1b[0m Hook scripts found`)
  } else {
    console.log(`\x1b[31m✗\x1b[0m Hook scripts missing — package may be corrupted`)
  }

  // Claude Code
  if (status.claude) {
    if (status.claude.installed) {
      const valid = status.claude.pathsValid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ stale paths\x1b[0m'
      console.log(`${valid} Claude Code: hooks registered (${status.claude.events.join(', ')})`)
    } else {
      console.log(`\x1b[33m-\x1b[0m Claude Code: not installed`)
    }
  } else {
    console.log(`\x1b[33m-\x1b[0m Claude Code: ~/.claude not found`)
  }

  // Codex
  if (status.codex) {
    if (status.codex.installed) {
      const valid = status.codex.pathsValid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ stale paths\x1b[0m'
      console.log(`${valid} Codex CLI: hooks registered (${status.codex.events.join(', ')})`)
    } else {
      console.log(`\x1b[33m-\x1b[0m Codex CLI: not installed`)
    }
  }

  // Active sessions
  const queuesDir = join(homedir(), '.promptline', 'queues')
  if (existsSync(queuesDir)) {
    let sessions = 0
    let pending = 0
    try {
      for (const project of readdirSync(queuesDir, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        for (const f of readdirSync(join(queuesDir, project.name))) {
          if (!f.endsWith('.json') || f.includes('.lock') || f.includes('.tmp')) continue
          try {
            const data = JSON.parse(readFileSync(join(queuesDir, project.name, f), 'utf-8'))
            if (!data.closedAt) sessions++
            pending += (data.prompts || []).filter(p => p.status === 'pending').length
          } catch {}
        }
      }
    } catch {}
    console.log(`\n  Active sessions: ${sessions}`)
    console.log(`  Pending prompts: ${pending}`)
  }

  process.exit(0)
}

// update
if (command === 'update') {
  const current = pkg.version
  const registry = npmRegistry()
  console.log(`\x1b[36m⟳\x1b[0m Current version: v${current}`)
  console.log(`  Checking for updates...`)
  try {
    const latest = npmViewLatestVersion(registry)
    if (!isNewerVersion(latest, current)) {
      console.log(`\x1b[32m✓\x1b[0m Already on the latest version (v${current})`)
      process.exit(0)
    }
    console.log(`\x1b[33m↑\x1b[0m New version available: v${latest}`)
    console.log(`  Updating...`)
    npmInstallLatest(registry)
    console.log(`\n\x1b[32m✓\x1b[0m Updated to v${latest}`)
  } catch (err) {
    const suffix = registry ? ` (registry: ${registry})` : ''
    console.error(`\x1b[31m✗\x1b[0m Update failed${suffix}: ${toErrorMessage(err)}`)
    process.exit(1)
  }
  process.exit(0)
}

// Default: launch dashboard
const claudeDir = join(homedir(), '.claude')
if (!existsSync(claudeDir)) {
  console.error('\x1b[31m✗\x1b[0m Claude Code not found. Install it first.')
  process.exit(1)
}

// Startup validation: check hooks are installed and paths are valid
const status = getStatus()
if (!status.claude || !status.claude.installed) {
  console.log('\x1b[33m!\x1b[0m PromptLine hooks are not installed.')
  console.log('  Run \x1b[36mpromptline install\x1b[0m to set up hooks for Claude Code.')
  console.log('  Run \x1b[36mpromptline install --codex\x1b[0m for Codex CLI.\n')
} else if (!status.claude.pathsValid) {
  console.log('\x1b[33m!\x1b[0m Hook script paths are outdated (nvm switch or npm reinstall?).')
  console.log('  Run \x1b[36mpromptline install\x1b[0m to repair.\n')
}

// Start Vite dev server
const viteBin = resolve(pkgDir, 'node_modules', '.bin', 'vite')
const vite = spawn(viteBin, [], {
  cwd: pkgDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '0' },
})

let opened = false
const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '')

vite.stdout.on('data', (data) => {
  const line = stripAnsi(data.toString())
  const match = line.match(/localhost:(\d+)/)
  if (match && !opened) {
    opened = true
    const port = match[1]
    const url = `http://localhost:${port}`
    console.log(`\x1b[32m✓\x1b[0m PromptLine running at \x1b[36m${url}\x1b[0m`)
    console.log(`  Press \x1b[33mCtrl+C\x1b[0m to stop\n`)
  }
})

vite.stderr.on('data', (data) => {
  const line = data.toString().trim()
  if (line && !line.includes('ExperimentalWarning')) {
    process.stderr.write(data)
  }
})

vite.on('close', (code) => process.exit(code ?? 0))

process.on('SIGINT', () => {
  cancelAllPendingPrompts()
  vite.kill('SIGINT')
  console.log('\n\x1b[33m⏹\x1b[0m PromptLine stopped.')
  process.exit(0)
})

function cancelAllPendingPrompts() {
  const queuesDir = join(homedir(), '.promptline', 'queues')
  let projectDirs
  try {
    projectDirs = readdirSync(queuesDir, { withFileTypes: true }).filter(d => d.isDirectory())
  } catch {
    return
  }
  const now = new Date().toISOString()
  for (const dir of projectDirs) {
    const projectPath = join(queuesDir, dir.name)
    let files
    try {
      files = readdirSync(projectPath).filter(f => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const file of files) {
      const filePath = join(projectPath, file)
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf-8'))
        if (data.closedAt) continue
        let changed = false
        for (const p of data.prompts || []) {
          if (p.status === 'pending' || p.status === 'running') {
            p.status = 'cancelled'
            p.completedAt = now
            changed = true
          }
        }
        if (changed) {
          data.lastActivity = now
          const tmpPath = `${filePath}.tmp.${process.pid}`
          writeFileSync(tmpPath, JSON.stringify(data, null, 2))
          renameSync(tmpPath, filePath)
        }
      } catch {
        continue
      }
    }
  }
}
```

- [ ] **Step 2: Verify it loads**

Run: `cd /Users/juanchirossi/Documents/Proyectos/promptline && node bin/promptline.mjs --version`

Expected: `promptline v1.3.21`

- [ ] **Step 3: Test status command**

Run: `node bin/promptline.mjs status`

Expected: Shows version, hook status (not installed since we haven't run install yet), session counts.

- [ ] **Step 4: Commit**

```bash
git add bin/promptline.mjs
git commit -m "feat: add install/uninstall/status commands, replace auto-install with validation"
```

---

## Task 6: Update `package.json` and remove old files

**Files:**
- Modify: `package.json` (update `files` array)
- Delete: `bin/install-hooks.mjs`
- Delete: `promptline-session-register.sh`
- Delete: `promptline-prompt-queue.sh`
- Delete: `promptline-session-end.sh`

- [ ] **Step 1: Update the `files` array in `package.json`**

Change the `files` field from:
```json
  "files": [
    "bin/",
    "scripts/",
    "src/",
    "promptline-*.sh",
    "vite-plugin-api.ts",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "index.html",
    "README.md"
  ],
```

to:
```json
  "files": [
    "bin/",
    "hooks/",
    "scripts/",
    "src/",
    "vite-plugin-api.ts",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "index.html",
    "README.md"
  ],
```

- [ ] **Step 2: Delete old files**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
rm bin/install-hooks.mjs
rm promptline-session-register.sh
rm promptline-prompt-queue.sh
rm promptline-session-end.sh
```

- [ ] **Step 3: Verify lint and build still pass**

Run: `npm run lint && npm run build`

Expected: Both pass with no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json
git add -u bin/install-hooks.mjs promptline-session-register.sh promptline-prompt-queue.sh promptline-session-end.sh
git commit -m "chore: remove legacy Python hooks and install-hooks, update package files"
```

---

## Task 7: End-to-end integration test

**Files:** No new files — manual verification.

- [ ] **Step 1: Test full install flow**

Run:
```bash
cd /Users/juanchirossi/Documents/Proyectos/promptline
node bin/promptline.mjs install
```

Expected:
```
✓ PromptLine hooks installed for Claude Code
```

- [ ] **Step 2: Verify settings.json was modified correctly**

Run:
```bash
cat ~/.claude/settings.json | jq '.hooks | keys'
```

Expected: Should include `SessionStart`, `Stop`, `SessionEnd` among the keys.

Run:
```bash
cat ~/.claude/settings.json | jq '.hooks.Stop[] | select(.hooks[].command | contains("@jxtools/promptline"))'
```

Expected: Shows the promptline Stop hook entry with the correct path.

- [ ] **Step 3: Test idempotent install**

Run:
```bash
node bin/promptline.mjs install
cat ~/.claude/settings.json | jq '[.hooks.Stop[] | select(.hooks[].command | contains("@jxtools/promptline"))] | length'
```

Expected: `1` (not duplicated)

- [ ] **Step 4: Test status command**

Run: `node bin/promptline.mjs status`

Expected: Shows Claude Code hooks as installed with valid paths.

- [ ] **Step 5: Test stop hook end-to-end with a real session file**

Run:
```bash
mkdir -p ~/.promptline/queues/testproject
echo '{"sessionId":"e2e-test","project":"testproject","directory":"/tmp","sessionName":"E2E","prompts":[{"id":"p1","text":"Hello world","status":"pending","createdAt":"2026-04-02T00:00:00.000Z"},{"id":"p2","text":"Run tests","status":"pending","createdAt":"2026-04-02T00:00:00.000Z"}],"startedAt":"2026-04-02T00:00:00.000Z","lastActivity":"2026-04-02T00:00:00.000Z","currentPromptId":null,"completedAt":null,"closedAt":null,"ownerPid":null,"ownerStartedAt":null}' > ~/.promptline/queues/testproject/e2e-test.json

# First stop: should pick up p1
echo '{"session_id":"e2e-test","cwd":"/tmp/testproject","transcript_path":"","stop_hook_active":false}' | bash hooks/stop-hook.sh

# Verify p1 is now running
cat ~/.promptline/queues/testproject/e2e-test.json | jq '.prompts[] | {id, status}'
```

Expected: p1 is `running`, p2 is `pending`. Stdout contains decision JSON with "Hello world".

- [ ] **Step 6: Second stop: should complete p1, pick up p2**

Run:
```bash
echo '{"session_id":"e2e-test","cwd":"/tmp/testproject","transcript_path":"","stop_hook_active":true}' | bash hooks/stop-hook.sh
cat ~/.promptline/queues/testproject/e2e-test.json | jq '.prompts[] | {id, status}'
```

Expected: p1 is `completed`, p2 is `running`. Stdout contains decision JSON with "Run tests".

- [ ] **Step 7: Third stop: queue empty, should exit silently**

Run:
```bash
echo '{"session_id":"e2e-test","cwd":"/tmp/testproject","transcript_path":"","stop_hook_active":true}' | bash hooks/stop-hook.sh
echo "Exit code: $?"
cat ~/.promptline/queues/testproject/e2e-test.json | jq '.prompts[] | {id, status}'
```

Expected: No stdout output. Exit code 0. Both prompts are `completed`.

- [ ] **Step 8: Test uninstall**

Run:
```bash
echo "n" | node bin/promptline.mjs uninstall
cat ~/.claude/settings.json | jq '[.hooks.Stop // [] | .[] | select(.hooks[].command | contains("@jxtools/promptline"))] | length'
```

Expected: `✓ PromptLine hooks removed from Claude Code` and count is `0`.

- [ ] **Step 9: Reinstall for continued use and clean up test data**

Run:
```bash
node bin/promptline.mjs install
rm -rf ~/.promptline/queues/testproject
```

- [ ] **Step 10: Verify lint and build pass**

Run: `npm run lint && npm run build`

Expected: Both pass.

- [ ] **Step 11: Commit any fixes found during testing**

If any fixes were needed, commit them:
```bash
git add -A
git commit -m "fix: address issues found during e2e testing"
```

---

## Task 8: Version bump and PR

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Bump version in `package.json`**

This is a minor version bump (new feature: install/uninstall commands, multi-agent support).

Change `"version": "1.3.21"` to `"version": "1.4.0"` in `package.json`.

- [ ] **Step 2: Final lint and build verification**

Run: `npm run lint && npm run build`

Expected: Both pass.

- [ ] **Step 3: Commit version bump**

```bash
git add package.json
git commit -m "chore: bump version to 1.4.0"
```

- [ ] **Step 4: Create PR**

```bash
git checkout -b feat/robust-hooks-multi-agent
git push -u origin feat/robust-hooks-multi-agent
gh pr create --title "feat: robust hooks, install/uninstall CLI, multi-agent support" --body "$(cat <<'EOF'
## Summary
- Replace Python-based hooks with shell+jq (removes python3 dependency)
- Add `promptline install`/`uninstall` CLI with flock-based atomic settings.json writes
- Add `promptline status` command
- Add `--codex` flag for Codex CLI support
- Startup validation warns if hooks are missing or stale
- Legacy hook migration and cleanup

## Spec
docs/superpowers/specs/2026-04-02-robust-hooks-and-multi-agent-design.md

## Test plan
- [ ] `promptline install` registers hooks in settings.json without corruption
- [ ] `promptline install` twice is idempotent (no duplicates)
- [ ] `promptline uninstall` removes only PromptLine hooks
- [ ] `promptline status` shows correct state
- [ ] Stop hook drains queue correctly (pending→running→completed)
- [ ] Session start creates/reopens sessions
- [ ] Session end closes sessions and sweeps orphans
- [ ] `npm run lint` passes
- [ ] `npm run build` passes
EOF
)"
```

- [ ] **Step 5: Merge PR**

```bash
gh pr merge --squash --delete-branch
```
