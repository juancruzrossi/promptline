#!/usr/bin/env node

import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgDir = resolve(__dirname, '..')
const registryFile = resolve(pkgDir, '.npm-registry')

function resolveRegistry(env) {
  const explicit = env.npm_config_registry || env.NPM_CONFIG_REGISTRY
  if (explicit) return explicit

  try {
    return execFileSync('npm', ['config', 'get', 'registry'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

const registry = resolveRegistry(process.env)
if (registry) {
  writeFileSync(registryFile, `${registry}\n`)
}
