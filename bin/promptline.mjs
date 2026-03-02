#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))

// --version
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`promptline v${pkg.version}`)
  process.exit(0)
}

// update
if (process.argv[2] === 'update') {
  const current = pkg.version
  console.log(`\x1b[36m⟳\x1b[0m Current version: v${current}`)
  console.log(`  Checking for updates...`)

  try {
    const latest = execSync('npm view @jxtools/promptline version', { encoding: 'utf-8' }).trim()

    if (latest === current) {
      console.log(`\x1b[32m✓\x1b[0m Already on the latest version (v${current})`)
      process.exit(0)
    }

    console.log(`\x1b[33m↑\x1b[0m New version available: v${latest}`)
    console.log(`  Updating...`)

    execSync('npm install -g @jxtools/promptline@latest', { stdio: 'inherit' })
    console.log(`\n\x1b[32m✓\x1b[0m Updated to v${latest}`)
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Update failed: ${err.message}`)
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
  vite.kill('SIGINT')
  console.log('\n\x1b[33m⏹\x1b[0m PromptLine stopped.')
  process.exit(0)
})

// --- Helpers ---

function installHooks() {
  // Copy hook scripts
  execSync(`mkdir -p "${hooksDir}"`)

  for (const file of hookFiles) {
    const src = join(pkgDir, file)
    const dest = join(hooksDir, file)
    copyFileSync(src, dest)
    chmodSync(dest, 0o755)
  }

  // Merge into settings.json
  const settingsPath = join(claudeDir, 'settings.json')
  let settings = {}

  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      // corrupted settings, start fresh
    }
  }

  if (!settings.hooks) settings.hooks = {}

  const hookConfig = {
    SessionStart: {
      file: 'promptline-session-register.sh',
    },
    Stop: {
      file: 'promptline-prompt-queue.sh',
    },
    SessionEnd: {
      file: 'promptline-session-end.sh',
    },
  }

  for (const [event, config] of Object.entries(hookConfig)) {
    const command = `~/.claude/hooks/${config.file}`

    if (!settings.hooks[event]) settings.hooks[event] = []

    const alreadyExists = settings.hooks[event].some(entry =>
      entry.hooks?.some(h => h.command === command)
    )

    if (!alreadyExists) {
      settings.hooks[event].push({
        hooks: [{ type: 'command', command }],
      })
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}
