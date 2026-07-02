import { readFile } from 'node:fs/promises'
import type { Issue, IssueComment } from './issues.ts'

export interface PromptContext {
  issue: Issue
  comments: IssueComment[]
  worktree: string
  branch: string
}

export async function buildPrompt(templatePath: string, ctx: PromptContext): Promise<string> {
  const template = await readFile(templatePath, 'utf8')
  const comments =
    ctx.comments.length === 0
      ? '(no comments)'
      : ctx.comments.map((c) => `**${c.author}:**\n${c.body}`).join('\n\n---\n\n')
  return template
    .replaceAll('{{NUMBER}}', String(ctx.issue.number))
    .replaceAll('{{TITLE}}', ctx.issue.title)
    .replaceAll('{{BODY}}', ctx.issue.body)
    .replaceAll('{{COMMENTS}}', comments)
    .replaceAll('{{WORKTREE}}', ctx.worktree)
    .replaceAll('{{BRANCH}}', ctx.branch)
}
