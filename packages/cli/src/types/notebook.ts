export type NotebookCellType = 'code' | 'markdown'

export type NotebookOutputImage = {
  image_data: string
  media_type: 'image/png' | 'image/jpeg'
}

export type NotebookCellOutput =
  | { output_type: 'stream'; text?: string | string[] }
  | { output_type: 'execute_result' | 'display_data'; data?: Record<string, unknown> }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] }

export type NotebookCell = {
  cell_type: NotebookCellType
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: NotebookCellOutput[]
  execution_count?: number
}

export type NotebookContent = {
  cells: NotebookCell[]
  metadata: {
    language_info?: {
      name?: string
    }
    [key: string]: unknown
  }
}

export type NotebookCellSourceOutput = {
  output_type: NotebookCellOutput['output_type']
  text?: string
  image?: NotebookOutputImage
}

export type NotebookCellSource = {
  cell: number
  cellType: NotebookCellType
  source: string
  language: string
  execution_count?: number
  outputs?: NotebookCellSourceOutput[]
}
