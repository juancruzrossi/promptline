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
import { spawnSync } from 'node:child_process'
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

// ── Agent configs ─────────────────────────────────────────────────────────────

const AGENT_CONFIGS = {
  claude: {
    label: 'Claude',
    dir: CLAUDE_DIR,
    settingsPath: CLAUDE_SETTINGS,
    events: Object.keys(HOOK_FILES),
    requireDir: true,
  },
  codex: {
    label: 'Codex',
    dir: CODEX_DIR,
    settingsPath: CODEX_SETTINGS,
    events: ['SessionStart', 'Stop'],
    requireDir: false,
  },
}

// ── Utilities ──────────────────────────────────────────────────────────────────

export function toErrorMessage(error, fallback = 'Unknown error') {
  return error instanceof Error && error.message ? error.message : fallback
}

function hasCommand(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  return !result.error && result.status === 0
}

function validateHookRuntime() {
  const missing = []
  if (!hasCommand('bash', ['--version'])) missing.push('bash')
  if (!hasCommand('jq')) missing.push('jq')

  if (missing.length > 0) {
    throw new Error(`Missing runtime dependency: ${missing.join(', ')}`)
  }
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
  if (shPath.includes(HOOK_MARKER)) return `bash "${shPath}"`
  return `bash "${shPath}" #@jxtools/promptline`
}

function isPromptLineEntry(entry) {
  return entry.hooks?.some(
    (h) =>
      h.command?.includes(HOOK_MARKER) || h.command?.includes(HOOKS_DIR + '/'),
  )
}

function isLegacyEntry(entry) {
  return entry.hooks?.some(
    (h) =>
      h.command?.includes(LEGACY_MARKER) &&
      !h.command?.includes(HOOK_MARKER) &&
      !h.command?.includes(HOOKS_DIR + '/'),
  )
}

function buildHookEntry(shPath) {
  return {
    hooks: [{ type: 'command', command: makeHookCommand(shPath) }],
  }
}

// ── Generic install / uninstall ───────────────────────────────────────────────

function installAgent(agentKey) {
  const config = AGENT_CONFIGS[agentKey]
  validateHookRuntime()

  if (config.requireDir && !existsSync(config.dir)) {
    throw new Error(`${config.label} directory not found: ${config.dir}`)
  }

  const hookPaths = resolveHookPaths()
  const missing = config.events.filter((k) => !hookPaths[k].exists)
  if (missing.length > 0) {
    throw new Error(`Hook scripts missing: ${missing.join(', ')}. Run install after hooks are created.`)
  }

  if (!config.requireDir) {
    mkdirSync(config.dir, { recursive: true })
  }

  const lockPath = `${config.settingsPath}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(config.settingsPath)
    } catch (err) {
      throw new Error(`${config.label} settings file is corrupted: ${toErrorMessage(err)}`)
    }

    backupPath = createBackup(config.settingsPath)

    if (!settings.hooks) settings.hooks = {}

    for (const event of Object.keys(settings.hooks)) {
      if (Array.isArray(settings.hooks[event])) {
        settings.hooks[event] = settings.hooks[event].filter(
          (entry) => !isLegacyEntry(entry),
        )
      }
    }

    for (const event of config.events) {
      const shPath = join(HOOKS_DIR, HOOK_FILES[event])
      if (!settings.hooks[event]) settings.hooks[event] = []

      const idx = settings.hooks[event].findIndex((e) => isPromptLineEntry(e))
      const entry = buildHookEntry(shPath)

      if (idx >= 0) {
        settings.hooks[event][idx] = entry
      } else {
        settings.hooks[event].push(entry)
      }
    }

    mkdirSync(dirname(config.settingsPath), { recursive: true })
    writeJsonAtomic(config.settingsPath, settings)

    try {
      validateWritten(config.settingsPath)
    } catch {
      restoreBackup(config.settingsPath, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(config.settingsPath)

    return { installed: true, message: `${config.label} hooks installed successfully` }
  } finally {
    releaseLock(lockPath)
  }
}

function uninstallAgent(agentKey) {
  const config = AGENT_CONFIGS[agentKey]

  if (!existsSync(config.settingsPath)) {
    return { removed: false, message: `No ${config.label} settings file found` }
  }

  const lockPath = `${config.settingsPath}.lock`
  acquireLock(lockPath)

  let backupPath = null
  try {
    let settings
    try {
      settings = readJsonSafe(config.settingsPath)
    } catch (err) {
      throw new Error(`${config.label} settings file is corrupted: ${toErrorMessage(err)}`)
    }

    if (!settings.hooks) {
      return { removed: false, message: `No hooks configured in ${config.label}` }
    }

    backupPath = createBackup(config.settingsPath)

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
      return { removed: false, message: `No PromptLine hooks found in ${config.label} settings` }
    }

    writeJsonAtomic(config.settingsPath, settings)

    try {
      validateWritten(config.settingsPath)
    } catch {
      restoreBackup(config.settingsPath, backupPath)
      throw new Error('Post-write validation failed, backup restored')
    }

    cleanOldBackups(config.settingsPath)

    return { removed: true, message: `PromptLine hooks removed from ${config.label} settings` }
  } finally {
    releaseLock(lockPath)
  }
}

// ── Public API (preserves existing signatures) ────────────────────────────────

export function installClaude() {
  return installAgent('claude')
}

export function uninstallClaude() {
  return uninstallAgent('claude')
}

export function installCodex() {
  return installAgent('codex')
}

export function uninstallCodex() {
  return uninstallAgent('codex')
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
