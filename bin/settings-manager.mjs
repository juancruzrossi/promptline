import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// ── Constants ──────────────────────────────────────────────────────────────────

export const HOOK_MARKER = '@jxtools/promptline/hooks/'
const LEGACY_MARKER = 'promptline-'
const LOCK_TIMEOUT_MS = 5000
const LOCK_POLL_MS = 50
const STALE_LOCK_THRESHOLD_MS = 10_000
const MAX_BACKUPS = 3

const HOME = process.env.HOME || process.env.USERPROFILE || ''
const CLAUDE_DIR = join(HOME, '.claude')
const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json')
const CODEX_DIR = join(HOME, '.codex')
const CODEX_SETTINGS = join(CODEX_DIR, 'hooks.json')

const PKG_DIR = resolve(__dirname, '..')
const HOOKS_DIR = join(PKG_DIR, 'hooks')

const HOOK_FILES = {
  SessionStart: 'session-start.sh',
  Stop: 'stop-hook.sh',
  SessionEnd: 'session-end.sh',
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function toErrorMessage(error, fallback = 'Unknown error') {
  return error instanceof Error && error.message ? error.message : fallback
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ── File locking ───────────────────────────────────────────────────────────────

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return
    } catch (err) {
      if (err.code !== 'EEXIST') throw err

      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
          try {
            unlinkSync(lockPath)
          } catch {
            // another process may have removed it
          }
          continue
        }
      } catch {
        continue
      }

      sleepMs(LOCK_POLL_MS)
    }
  }

  throw new Error(`Timed out acquiring lock: ${lockPath}`)
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath)
  } catch {
    // already removed
  }
}

// ── Atomic JSON I/O ────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {}
  const raw = readFileSync(filePath, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(`File is not valid JSON: ${filePath}`)
  }
}

function createBackup(filePath) {
  if (!existsSync(filePath)) return null
  const ts = Date.now()
  const backupPath = `${filePath}.bak.${ts}`
  copyFileSync(filePath, backupPath)
  return backupPath
}

function cleanOldBackups(filePath) {
  const dir = dirname(filePath)
  const base = `${filePath.split('/').pop()}.bak.`
  let backups = []
  try {
    backups = readdirSync(dir)
      .filter((f) => f.startsWith(base))
      .sort()
  } catch {
    return
  }
  while (backups.length > MAX_BACKUPS) {
    const oldest = backups.shift()
    try {
      unlinkSync(join(dir, oldest))
    } catch {
      // ignore
    }
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp.${process.pid}`
  const content = JSON.stringify(data, null, 2) + '\n'

  try {
    writeFileSync(tmpPath, content)
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    throw err
  }
}

function validateWritten(filePath) {
  const raw = readFileSync(filePath, 'utf-8')
  JSON.parse(raw)
}

function restoreBackup(filePath, backupPath) {
  if (backupPath && existsSync(backupPath)) {
    copyFileSync(backupPath, filePath)
  }
}

// ── Hook path resolution ───────────────────────────────────────────────────────

export function resolveHookPaths() {
  const paths = {}
  for (const [event, file] of Object.entries(HOOK_FILES)) {
    const abs = join(HOOKS_DIR, file)
    paths[event] = { path: abs, exists: existsSync(abs) }
  }
  return paths
}

// ── Hook entry helpers ─────────────────────────────────────────────────────────

function makeHookCommand(shPath) {
  return `bash "${shPath}"`
}

function isPromptLineEntry(entry) {
  return entry.hooks?.some((h) => h.command?.includes(HOOK_MARKER))
}

function isLegacyEntry(entry) {
  return entry.hooks?.some(
    (h) =>
      h.command?.includes(LEGACY_MARKER) &&
      !h.command?.includes(HOOK_MARKER),
  )
}

function buildHookEntry(shPath) {
  return {
    hooks: [{ type: 'command', command: makeHookCommand(shPath) }],
  }
}

// ── Claude install / uninstall ─────────────────────────────────────────────────

export function installClaude() {
  if (!existsSync(CLAUDE_DIR)) {
    throw new Error(`Claude directory not found: ${CLAUDE_DIR}`)
  }

  const hookPaths = resolveHookPaths()
  const missing = Object.entries(hookPaths)
    .filter(([, v]) => !v.exists)
    .map(([k]) => k)
  if (missing.length > 0) {
    throw new Error(`Hook scripts missing: ${missing.join(', ')}. Run install after hooks are created.`)
  }

  const lockPath = `${CLAUDE_SETTINGS}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(CLAUDE_SETTINGS)
    } catch (err) {
      throw new Error(`Claude settings file is corrupted: ${toErrorMessage(err)}`)
    }

    backupPath = createBackup(CLAUDE_SETTINGS)

    if (!settings.hooks) settings.hooks = {}

    // Remove legacy entries
    for (const event of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(
          (entry) => !isLegacyEntry(entry),
        )
      }
    }

    // Add/update PromptLine entries
    for (const [event, file] of Object.entries(HOOK_FILES)) {
      const shPath = join(HOOKS_DIR, file)
      if (!settings.hooks[event]) settings.hooks[event] = []

      const idx = settings.hooks[event].findIndex((e) => isPromptLineEntry(e))
      const entry = buildHookEntry(shPath)

      if (idx >= 0) {
        settings.hooks[event][idx] = entry
      } else {
        settings.hooks[event].push(entry)
      }
    }

    mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true })
    writeJsonAtomic(CLAUDE_SETTINGS, settings)

    try {
      validateWritten(CLAUDE_SETTINGS)
    } catch {
      restoreBackup(CLAUDE_SETTINGS, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(CLAUDE_SETTINGS)

    return { installed: true, message: 'Claude hooks installed successfully' }
  } finally {
    releaseLock(lockPath)
  }
}

export function uninstallClaude() {
  if (!existsSync(CLAUDE_SETTINGS)) {
    return { removed: false, message: 'No Claude settings file found' }
  }

  const lockPath = `${CLAUDE_SETTINGS}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(CLAUDE_SETTINGS)
    } catch (err) {
      throw new Error(`Claude settings file is corrupted: ${toErrorMessage(err)}`)
    }

    if (!settings.hooks) {
      return { removed: false, message: 'No hooks configured in Claude settings' }
    }

    backupPath = createBackup(CLAUDE_SETTINGS)

    let removed = false
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue
      const before = settings.hooks[event].length
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) => !isPromptLineEntry(entry),
      )
      if (settings.hooks[event].length < before) removed = true
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event]
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }

    if (!removed) {
      return { removed: false, message: 'No PromptLine hooks found in Claude settings' }
    }

    writeJsonAtomic(CLAUDE_SETTINGS, settings)

    try {
      validateWritten(CLAUDE_SETTINGS)
    } catch {
      restoreBackup(CLAUDE_SETTINGS, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(CLAUDE_SETTINGS)

    return { removed: true, message: 'PromptLine hooks removed from Claude settings' }
  } finally {
    releaseLock(lockPath)
  }
}

// ── Codex install / uninstall ──────────────────────────────────────────────────

export function installCodex() {
  const hookPaths = resolveHookPaths()
  const needed = ['SessionStart', 'Stop']
  const missing = needed.filter((k) => !hookPaths[k].exists)
  if (missing.length > 0) {
    throw new Error(`Hook scripts missing: ${missing.join(', ')}. Run install after hooks are created.`)
  }

  mkdirSync(CODEX_DIR, { recursive: true })

  const lockPath = `${CODEX_SETTINGS}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(CODEX_SETTINGS)
    } catch (err) {
      throw new Error(`Codex hooks file is corrupted: ${toErrorMessage(err)}`)
    }

    backupPath = createBackup(CODEX_SETTINGS)

    if (!settings.hooks) settings.hooks = {}

    // Remove legacy entries
    for (const event of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(
          (entry) => !isLegacyEntry(entry),
        )
      }
    }

    // Only SessionStart and Stop for Codex (no SessionEnd)
    const codexHooks = { SessionStart: HOOK_FILES.SessionStart, Stop: HOOK_FILES.Stop }

    for (const [event, file] of Object.entries(codexHooks)) {
      const shPath = join(HOOKS_DIR, file)
      if (!settings.hooks[event]) settings.hooks[event] = []

      const idx = settings.hooks[event].findIndex((e) => isPromptLineEntry(e))
      const entry = buildHookEntry(shPath)

      if (idx >= 0) {
        settings.hooks[event][idx] = entry
      } else {
        settings.hooks[event].push(entry)
      }
    }

    writeJsonAtomic(CODEX_SETTINGS, settings)

    try {
      validateWritten(CODEX_SETTINGS)
    } catch {
      restoreBackup(CODEX_SETTINGS, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(CODEX_SETTINGS)

    return { installed: true, message: 'Codex hooks installed successfully' }
  } finally {
    releaseLock(lockPath)
  }
}

export function uninstallCodex() {
  if (!existsSync(CODEX_SETTINGS)) {
    return { removed: false, message: 'No Codex hooks file found' }
  }

  const lockPath = `${CODEX_SETTINGS}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(CODEX_SETTINGS)
    } catch (err) {
      throw new Error(`Codex hooks file is corrupted: ${toErrorMessage(err)}`)
    }

    if (!settings.hooks) {
      return { removed: false, message: 'No hooks configured in Codex' }
    }

    backupPath = createBackup(CODEX_SETTINGS)

    let removed = false
    for (const event of Object.keys(settings.hooks)) {
      if (!Array.isArray(settings.hooks[event])) continue
      const before = settings.hooks[event].length
      settings.hooks[event] = settings.hooks[event].filter(
        (entry) => !isPromptLineEntry(entry),
      )
      if (settings.hooks[event].length < before) removed = true
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event]
      }
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks
    }

    if (!removed) {
      return { removed: false, message: 'No PromptLine hooks found in Codex' }
    }

    writeJsonAtomic(CODEX_SETTINGS, settings)

    try {
      validateWritten(CODEX_SETTINGS)
    } catch {
      restoreBackup(CODEX_SETTINGS, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(CODEX_SETTINGS)

    return { removed: true, message: 'PromptLine hooks removed from Codex' }
  } finally {
    releaseLock(lockPath)
  }
}

// ── Status ─────────────────────────────────────────────────────────────────────

function extractScriptPath(command) {
  const match = command?.match(/"([^"]+)"/)
  return match ? match[1] : null
}

function getAgentStatus(settingsPath) {
  try {
    if (!existsSync(settingsPath)) return null

    const settings = readJsonSafe(settingsPath)
    if (!settings.hooks) return { installed: false, events: [], pathsValid: true }

    const events = []
    const scriptPaths = []

    for (const [event, arr] of Object.entries(settings.hooks)) {
      if (!Array.isArray(arr)) continue
      for (const entry of arr) {
        if (!isPromptLineEntry(entry)) continue
        events.push(event)
        for (const h of entry.hooks || []) {
          const sp = extractScriptPath(h.command)
          if (sp) scriptPaths.push(sp)
        }
      }
    }

    const installed = events.length > 0
    const pathsValid = installed ? scriptPaths.every((p) => existsSync(p)) : true

    return { installed, events, pathsValid }
  } catch {
    return null
  }
}

export function getStatus() {
  const hookPaths = resolveHookPaths()

  return {
    hookPaths,
    claude: getAgentStatus(CLAUDE_SETTINGS),
    codex: getAgentStatus(CODEX_SETTINGS),
  }
}

// ── Legacy hook cleanup ────────────────────────────────────────────────────────

export function findLegacyHookFiles() {
  const legacyDir = join(CLAUDE_DIR, 'hooks')
  if (!existsSync(legacyDir)) return []

  try {
    return readdirSync(legacyDir)
      .filter((f) => f.startsWith(LEGACY_MARKER) && f.endsWith('.sh'))
      .map((f) => join(legacyDir, f))
  } catch {
    return []
  }
}

export function removeLegacyHookFiles(files) {
  const results = []
  for (const f of files) {
    try {
      unlinkSync(f)
      results.push({ file: f, removed: true })
    } catch (err) {
      results.push({ file: f, removed: false, error: toErrorMessage(err) })
    }
  }
  return results
}
