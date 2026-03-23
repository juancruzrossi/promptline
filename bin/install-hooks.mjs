import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

export function toErrorMessage(error, fallback = 'Unknown error') {
  return error instanceof Error && error.message ? error.message : fallback
}

export function hasCommand(command, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, ['--version'], { stdio: 'ignore' })
  return !result.error && result.status === 0
}

export function loadSettings(settingsPath) {
  if (!existsSync(settingsPath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(settingsPath, 'utf-8'))
  } catch (error) {
    throw new Error(`Claude settings file is corrupted: ${toErrorMessage(error)}`)
  }
}

export function writeJsonAtomic(settingsPath, data) {
  const tmpPath = `${settingsPath}.tmp`
  const backupPath = `${settingsPath}.bak`

  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, backupPath)
  }

  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmpPath, settingsPath)
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore cleanup errors
    }
    throw error
  }
}

export function installHooks({ claudeDir, hooksDir, pkgDir, hookFiles, commandAvailable = hasCommand }) {
  if (!commandAvailable('python3')) {
    throw new Error('python3 is required to install PromptLine hooks')
  }

  mkdirSync(hooksDir, { recursive: true })

  for (const file of hookFiles) {
    const src = join(pkgDir, file)
    const dest = join(hooksDir, file)
    copyFileSync(src, dest)
    chmodSync(dest, 0o755)
  }

  const settingsPath = join(claudeDir, 'settings.json')
  const settings = loadSettings(settingsPath)

  if (!settings.hooks) {
    settings.hooks = {}
  }

  const hookConfig = {
    SessionStart: { file: 'promptline-session-register.sh' },
    Stop: { file: 'promptline-prompt-queue.sh' },
    SessionEnd: { file: 'promptline-session-end.sh' },
  }

  let changed = false

  for (const [event, config] of Object.entries(hookConfig)) {
    const command = `~/.claude/hooks/${config.file}`

    if (!settings.hooks[event]) {
      settings.hooks[event] = []
      changed = true
    }

    const alreadyExists = settings.hooks[event].some((entry) =>
      entry.hooks?.some((hook) => hook.command === command),
    )

    if (!alreadyExists) {
      settings.hooks[event].push({
        hooks: [{ type: 'command', command }],
      })
      changed = true
    }
  }

  if (changed) {
    writeJsonAtomic(settingsPath, settings)
  }
}
