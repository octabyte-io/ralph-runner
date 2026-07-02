#!/usr/bin/env node
// Installed package: run the compiled output (built by `prepare` — Node
// refuses to type-strip under node_modules). Dev checkout: run the
// TypeScript sources directly (Node >= 24 type stripping).
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = new URL('../dist/main.js', import.meta.url)
await import(existsSync(fileURLToPath(dist)) ? dist.href : new URL('../src/main.ts', import.meta.url).href)
