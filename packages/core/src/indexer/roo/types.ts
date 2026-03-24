/** One semantic chunk segment for vector indexing. */
export interface CodeBlock {
  file_path: string
  identifier: string | null
  type: string
  start_line: number
  end_line: number
  content: string
  fileHash: string
  segmentHash: string
}
