export const PROMPT = `Write a file to the local filesystem. Overwrites the existing file if there is one.

Before using this tool:

1. Use the View tool to understand the file's contents and context

2. Directory Verification (only applicable when creating new files):
   - Use the LS tool to verify the parent directory exists and is the correct location

Prefer editing existing files when possible. Do not create docs or README files unless the user explicitly asked for them.`

export const DESCRIPTION = 'Write a file to the local filesystem.'
