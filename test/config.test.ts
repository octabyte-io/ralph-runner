import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, packageRoot, DEFAULT_LABELS } from '../src/config.ts'

function scratchRepo(): string {
  return mkdtempSync(join(tmpdir(), 'ralph-config-test-'))
}

function writeConfig(root: string, config: unknown): void {
  mkdirSync(join(root, '.ralph'), { recursive: true })
  writeFileSync(join(root, '.ralph', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
}

test('defaults apply when no config file exists', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cfg = loadConfig(root, {}, {})
  assert.equal(cfg.mainBranch, 'main')
  assert.equal(cfg.concurrency, 3)
  assert.equal(cfg.maxMinutes, 30)
  assert.equal(cfg.pollIntervalMs, 30_000)
  assert.equal(cfg.setupCommand, 'pnpm install --prefer-offline')
  assert.equal(cfg.verifyCommand, 'pnpm run test')
  assert.deepEqual(cfg.labels, DEFAULT_LABELS)
  assert.equal(cfg.logDir, join(root, '.ralph', 'logs'))
  assert.equal(cfg.worktreesDir, join(root, '.worktrees'))
  // no project prompt → shipped template
  assert.equal(cfg.promptTemplatePath, join(packageRoot(), 'prompt-template.md'))
})

test('file config overrides defaults and merges labels partially', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, {
    mainBranch: 'develop',
    concurrency: 5,
    pollIntervalSeconds: 10,
    labels: { ready: 'agent-go' },
    setupCommand: 'npm ci',
    verifyCommand: 'npm test',
    envFiles: ['.env', 'apps/api/.env'],
    logDir: 'logs/ralph',
  })
  const cfg = loadConfig(root, {}, {})
  assert.equal(cfg.mainBranch, 'develop')
  assert.equal(cfg.concurrency, 5)
  assert.equal(cfg.pollIntervalMs, 10_000)
  assert.equal(cfg.labels.ready, 'agent-go')
  assert.equal(cfg.labels.inProgress, DEFAULT_LABELS.inProgress) // unmentioned → default
  assert.equal(cfg.setupCommand, 'npm ci')
  assert.equal(cfg.verifyCommand, 'npm test')
  assert.deepEqual(cfg.envFiles, ['.env', 'apps/api/.env'])
  assert.equal(cfg.logDir, join(root, 'logs', 'ralph'))
})

test('precedence: CLI beats env beats file', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, { concurrency: 5, maxMinutes: 60, verifyCommand: 'from-file' })
  const env = { RALPH_VERIFY_CMD: 'from-env', RALPH_CLAUDE_CMD: 'fake-claude' }
  assert.equal(loadConfig(root, {}, env).verifyCommand, 'from-env')
  assert.equal(loadConfig(root, {}, env).claudeCmd, 'fake-claude')
  const cfg = loadConfig(root, { concurrency: 2, maxMinutes: 10, verifyCmd: 'from-cli' }, env)
  assert.equal(cfg.concurrency, 2)
  assert.equal(cfg.maxMinutes, 10)
  assert.equal(cfg.verifyCommand, 'from-cli')
})

test('project prompt is used when present', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.ralph'), { recursive: true })
  writeFileSync(join(root, '.ralph', 'prompt.md'), 'custom prompt {{NUMBER}}')
  const cfg = loadConfig(root, {}, {})
  assert.equal(cfg.promptTemplatePath, join(root, '.ralph', 'prompt.md'))
})

test('malformed config fails with a clear error', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, '{ not json')
  assert.throws(() => loadConfig(root, {}, {}), /invalid JSON in .*config\.json/)
  writeConfig(root, '[1, 2]')
  assert.throws(() => loadConfig(root, {}, {}), /must contain a JSON object/)
})

test('custom priority config is threaded through', (t) => {
  const root = scratchRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, { priority: { labelRanks: { hotfix: 0 }, defaultRank: 9 } })
  const cfg = loadConfig(root, {}, {})
  assert.deepEqual(cfg.priority.labelRanks, { hotfix: 0 })
  assert.equal(cfg.priority.defaultRank, 9)
  // unspecified titleRanks keep the default rules
  assert.ok(cfg.priority.titleRanks.some((r) => r.pattern === 'tracer'))
})
