import {
  buildReviewInstruction,
  buildReviewPromptBranch,
  buildReviewPromptUncommitted,
  resolveReviewRequest,
} from '@nexuscode/core'
import { Command } from '../commands.js'
import { getCwd } from '../utils/state.js'

export default {
  type: 'prompt',
  name: 'review',
  description: 'Launch a read-only reviewer for current, branch, or commit changes',
  isEnabled: true,
  isHidden: false,
  progressMessage: 'launching the code reviewer',
  userFacingName() {
    return 'review'
  },
  async getPromptForCommand(args: string) {
    // `--cwd` is tracked by the CLI state layer and intentionally does not
    // mutate process.cwd(). Review the selected workspace, not the shell that
    // happened to launch NexusCode.
    const cwd = getCwd()
    const request = await resolveReviewRequest(cwd, args)
    const text =
      request.target.kind === 'uncommitted'
        ? await buildReviewPromptUncommitted(cwd, request.guidance)
        : request.target.kind === 'branch'
          ? await buildReviewPromptBranch(
              cwd,
              request.target.base,
              request.guidance,
            )
          : buildReviewInstruction(request)

    return [
      {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    ]
  },
} satisfies Command
