#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execFileSync } from 'child_process'
import { homedir } from 'os'
import { installHooks as installPromptlineHooks, toErrorMessage } from './install-hooks.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
const registryFile = resolve(pkgDir, '.npm-registry')

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

// --version
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`promptline v${pkg.version}`)
  process.exit(0)
}

// update
if (process.argv[2] === 'update') {
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

// Check Claude Code is installed
const claudeDir = join(homedir(), '.claude')
if (!existsSync(claudeDir)) {
  console.error('\x1b[31m✗\x1b[0m Claude Code not found. Install it first.')
  process.exit(1)
}

// Check hooks installation
const hooksDir = join(claudeDir, 'hooks')
const hookFiles = [
  'promptline-session-register.sh',
  'promptline-prompt-queue.sh',
  'promptline-session-end.sh',
]

installHooks()

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

// --- Cleanup ---

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

// --- Helpers ---

function installHooks() {
  try {
    installPromptlineHooks({
      claudeDir,
      hooksDir,
      pkgDir,
      hookFiles,
    })
  } catch (error) {
    console.error(`\x1b[31m✗\x1b[0m ${toErrorMessage(error)}`)
    process.exit(1)
  }
}
