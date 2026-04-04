#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync, openSync, closeSync, statSync, unlinkSync } from 'fs'
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return version
    .replace(/^v/, '')
    .split('.')
    .map(part => part.padStart(6, '0'))
    .join('')
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
    env: {
      ...process.env,
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '5000',
    },
  }).trim()
}

function npmInstallLatest(registry) {
  const args = ['install', '-g', '@jxtools/promptline@latest']
  if (registry) args.push('--registry', registry)

  execFileSync('npm', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '10000',
    },
  })
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

function acquireFileLock(lockPath, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return true
    } catch (err) {
      if (err.code !== 'EEXIST') return false
      try {
        const stat = statSync(lockPath)
        if (Date.now() - stat.mtimeMs > 10_000) {
          try { unlinkSync(lockPath) } catch { /* ignore */ }
          continue
        }
      } catch { continue }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
  }
  return false
}

function releaseFileLock(lockPath) {
  try { unlinkSync(lockPath) } catch { /* ignore */ }
}

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
      const lockPath = `${filePath}.lock`
      if (!acquireFileLock(lockPath, 1000)) continue
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
      } finally {
        releaseFileLock(lockPath)
      }
    }
  }
}

function countActiveSessions() {
  const queuesDir = join(homedir(), '.promptline', 'queues')
  let sessions = 0
  let pending = 0
  try {
    const projectDirs = readdirSync(queuesDir, { withFileTypes: true }).filter(d => d.isDirectory())
    for (const dir of projectDirs) {
      const projectPath = join(queuesDir, dir.name)
      try {
        const files = readdirSync(projectPath).filter(f => f.endsWith('.json'))
        for (const file of files) {
          try {
            const data = JSON.parse(readFileSync(join(projectPath, file), 'utf-8'))
            if (data.closedAt) continue
            sessions++
            for (const p of data.prompts || []) {
              if (p.status === 'pending') pending++
            }
          } catch {
            continue
          }
        }
      } catch {
        continue
      }
    }
  } catch {
    // queues dir doesn't exist
  }
  return { sessions, pending }
}

// ── Commands ──────────────────────────────────────────────────────────────────

// --version
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`promptline v${pkg.version}`)
  process.exit(0)
}

const command = process.argv[2]
const flags = process.argv.slice(3)

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

// install
if (command === 'install') {
  try {
    if (flags.includes('--codex')) {
      installCodex()
      console.log(`\x1b[32m✓\x1b[0m PromptLine hooks installed for Codex`)
    } else {
      installClaude()
      console.log(`\x1b[32m✓\x1b[0m PromptLine hooks installed for Claude Code`)

      const legacyFiles = findLegacyHookFiles()
      if (legacyFiles.length > 0) {
        const answer = await ask(
          `\x1b[33m!\x1b[0m Found ${legacyFiles.length} legacy hook files in ~/.claude/hooks/. Remove them? [y/N] `,
        )
        if (answer === 'y' || answer === 'yes') {
          removeLegacyHookFiles(legacyFiles)
          console.log(`\x1b[32m✓\x1b[0m Legacy hook files removed`)
        }
      }
    }
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Install failed: ${toErrorMessage(err)}`)
    process.exit(1)
  }

  process.exit(0)
}

// uninstall
if (command === 'uninstall') {
  try {
    if (flags.includes('--codex')) {
      const result = uninstallCodex()
      if (result.removed) {
        console.log(`\x1b[32m✓\x1b[0m PromptLine hooks removed from Codex`)
      } else {
        console.log(`\x1b[33m!\x1b[0m No PromptLine hooks found in Codex`)
      }
    } else {
      const result = uninstallClaude()
      if (result.removed) {
        console.log(`\x1b[32m✓\x1b[0m PromptLine hooks removed from Claude Code`)

        const queuesDir = join(homedir(), '.promptline', 'queues')
        if (existsSync(queuesDir)) {
          const answer = await ask(
            `  Delete queue data? (~/.promptline/queues/) [y/N] `,
          )
          if (answer === 'y' || answer === 'yes') {
            rmSync(queuesDir, { recursive: true, force: true })
            console.log(`\x1b[32m✓\x1b[0m Queue data deleted`)
          }
        }
      } else {
        console.log(`\x1b[33m!\x1b[0m No PromptLine hooks found`)
      }
    }
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Uninstall failed: ${toErrorMessage(err)}`)
    process.exit(1)
  }

  process.exit(0)
}

// status
if (command === 'status') {
  const status = getStatus()
  const { sessions, pending } = countActiveSessions()

  console.log(`\x1b[36mPromptLine\x1b[0m v${pkg.version}\n`)

  console.log(`\x1b[1mHook Scripts:\x1b[0m`)
  for (const [event, info] of Object.entries(status.hookPaths)) {
    const icon = info.exists ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    console.log(`  ${icon} ${event}: ${info.path}`)
  }

  console.log()
  console.log(`\x1b[1mClaude Code:\x1b[0m`)
  if (status.claude === null) {
    console.log(`  \x1b[33m-\x1b[0m Not detected (~/.claude not found)`)
  } else if (!status.claude.installed) {
    console.log(`  \x1b[33m-\x1b[0m Not installed (run \x1b[36mpromptline install\x1b[0m)`)
  } else {
    const pathIcon = status.claude.pathsValid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    console.log(`  \x1b[32m✓\x1b[0m Installed (events: ${status.claude.events.join(', ')})`)
    console.log(`  ${pathIcon} Hook paths ${status.claude.pathsValid ? 'valid' : 'outdated — run promptline install'}`)
  }

  console.log()
  console.log(`\x1b[1mCodex:\x1b[0m`)
  if (status.codex === null) {
    console.log(`  \x1b[33m-\x1b[0m Not detected (~/.codex not found)`)
  } else if (!status.codex.installed) {
    console.log(`  \x1b[33m-\x1b[0m Not installed (run \x1b[36mpromptline install --codex\x1b[0m)`)
  } else {
    const pathIcon = status.codex.pathsValid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
    console.log(`  \x1b[32m✓\x1b[0m Installed (events: ${status.codex.events.join(', ')})`)
    console.log(`  ${pathIcon} Hook paths ${status.codex.pathsValid ? 'valid' : 'outdated — run promptline install --codex'}`)
  }

  console.log()
  console.log(`\x1b[1mSessions:\x1b[0m`)
  console.log(`  Active: ${sessions}  |  Pending prompts: ${pending}`)

  process.exit(0)
}

// ── Default: launch dashboard ─────────────────────────────────────────────────

// Startup validation
const claudeDir = join(homedir(), '.claude')
const status = getStatus()

if (!existsSync(claudeDir)) {
  console.warn(`\x1b[33m!\x1b[0m Claude Code not detected. Run \x1b[36mpromptline install\x1b[0m first.`)
} else if (!status.claude?.installed) {
  console.warn(`\x1b[33m!\x1b[0m PromptLine hooks not installed. Run \x1b[36mpromptline install\x1b[0m first.`)
} else if (!status.claude.pathsValid) {
  console.warn(`\x1b[33m!\x1b[0m Hook paths outdated. Run \x1b[36mpromptline install\x1b[0m to update.`)
}

// Launch Vite dev server
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
