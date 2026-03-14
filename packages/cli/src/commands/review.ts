import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { Command } from '../commands.js'

const execFile = promisify(execFileCb)

type DiffFile = { path: string; oldPath?: string; status: 'added' | 'deleted' | 'modified' | 'renamed' }

async function runGit(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['-c', 'core.quotepath=false', ...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

function parseDiffFiles(rawDiff: string): DiffFile[] {
  if (!rawDiff.trim()) return []
  const chunks = rawDiff.split(/^diff --git /m).filter(Boolean)
  const files: DiffFile[] = []
  for (const chunk of chunks) {
    const content = `diff --git ${chunk}`
    const lines = content.split('\n')
    const header = lines[0]?.match(/^diff --git a\/(.+) b\/(.+)$/)
    if (!header) continue
    const oldPath = header[1]
    const newPath = header[2]
    const isNew = lines.some(line => line.startsWith('new file mode'))
    const isDeleted = lines.some(line => line.startsWith('deleted file mode'))
    const isRenamed = lines.some(line => line.startsWith('rename from'))
    const status: DiffFile['status'] = isNew
      ? 'added'
      : isDeleted
        ? 'deleted'
        : isRenamed
          ? 'renamed'
          : 'modified'
    files.push({
      path: newPath,
      oldPath: isRenamed && oldPath !== newPath ? oldPath : undefined,
      status,
    })
  }
  return files
}

function formatFileList(files: DiffFile[]): string {
  return files
    .map(file => {
      const marker =
        file.status === 'added'
          ? '[A]'
          : file.status === 'deleted'
            ? '[D]'
            : file.status === 'renamed'
              ? '[R]'
              : '[M]'
      const renamed = file.oldPath ? ` (was: ${file.oldPath})` : ''
      return `- ${marker} ${file.path}${renamed}`
    })
    .join('\n')
}

export default {
  type: 'prompt',
  name: 'review',
  description: 'Review current local changes',
  isEnabled: true,
  isHidden: false,
  progressMessage: 'running local code review',
  userFacingName() {
    return 'review'
  },
  async getPromptForCommand() {
    const diff = await runGit(['diff', 'HEAD'])
    const files = parseDiffFiles(diff)
    if (files.length === 0) {
      return [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `You are an expert code reviewer. There are no uncommitted changes to review.

Return exactly:

## Local Review
### Summary
No changes detected.
### Issues Found
No issues found.
### Recommendation
APPROVE`,
            },
          ],
        },
      ]
    }

    const fileList = formatFileList(files)
    return [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are an expert code reviewer. Review local uncommitted changes from this repository.

Files changed:
${fileList}

Rules:
- Focus on bugs, regressions, security, correctness, and missing tests.
- Do not rewrite files. Provide findings only.
- Read extra file context when needed before asserting issues.

Output format:
## Local Review
### Summary
[2-3 sentences]
### Issues Found
| Severity | File:Line | Issue |
|----------|-----------|-------|
[Rows or "No issues found."]
### Detailed Findings
[Per issue: confidence, problem, fix recommendation]
### Recommendation
[APPROVE | APPROVE WITH SUGGESTIONS | NEEDS CHANGES]`,
          },
        ],
      },
    ]
  },
} satisfies Command
