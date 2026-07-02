import { mkdir, readFile, writeFile, copyFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_RELPATH, DEFAULT_FILE_CONFIG, packageRoot } from './config.ts'

const GITIGNORE_ENTRIES = ['.worktrees/', '.ralph/logs/']

/**
 * Scaffold .ralph/config.json (fully-populated defaults, so it
 * self-documents), .ralph/prompt.md (starter copy of the shipped
 * template) and .gitignore entries. Never overwrites existing files.
 */
export async function init(root: string): Promise<void> {
  const say = (line: string) => process.stdout.write(`${line}\n`)
  await mkdir(join(root, '.ralph'), { recursive: true })

  const configPath = join(root, CONFIG_RELPATH)
  if (existsSync(configPath)) {
    say(`skipped ${CONFIG_RELPATH} (already exists)`)
  } else {
    await writeFile(configPath, JSON.stringify(DEFAULT_FILE_CONFIG, null, 2) + '\n')
    say(`wrote ${CONFIG_RELPATH}`)
  }

  const promptRel = DEFAULT_FILE_CONFIG.promptPath
  const promptPath = join(root, promptRel)
  if (existsSync(promptPath)) {
    say(`skipped ${promptRel} (already exists)`)
  } else {
    await copyFile(join(packageRoot(), 'prompt-template.md'), promptPath)
    say(`wrote ${promptRel} — edit it to describe your project's stack and rules`)
  }

  const gitignorePath = join(root, '.gitignore')
  const existing = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf8') : ''
  const lines = new Set(existing.split('\n').map((l) => l.trim()))
  const missing = GITIGNORE_ENTRIES.filter((e) => !lines.has(e))
  if (missing.length === 0) {
    say('skipped .gitignore (entries already present)')
  } else {
    const lead = existing === '' || existing.endsWith('\n') ? '' : '\n'
    await appendFile(gitignorePath, `${lead}${missing.join('\n')}\n`)
    say(`added to .gitignore: ${missing.join(', ')}`)
  }

  say('\nralph is set up. Review .ralph/config.json, then run: ralph --dry-run')
}
