import { normalizeChangePath } from "./hash.js"
import type {
  ChangeFileRecord,
  ChangeRestoreDirection,
  ChangeRestorePlanMutation,
  ChangeSetRecord,
  ChangeSetRestorePlan,
  FileStateRef,
} from "./types.js"

const ABSENT: FileStateRef = {
  exists: false,
  hash: null,
  blob: null,
  byteLength: 0,
  mode: null,
}

export interface BuildChangeSetRestorePlanOptions {
  readonly direction: ChangeRestoreDirection
  /**
   * Logical file destinations to include. A rename may also be selected by
   * its old path, but both paths still produce one indivisible two-step item.
   */
  readonly paths?: readonly string[]
}

function cloneRef(ref: FileStateRef): FileStateRef {
  return structuredClone(ref)
}

function ordinaryMutation(
  file: ChangeFileRecord,
  direction: ChangeRestoreDirection,
): ChangeRestorePlanMutation {
  return {
    changePath: file.path,
    mutationPath: file.path,
    operation: file.operation,
    expected: cloneRef(direction === "apply" ? file.applyBase : file.after),
    target: cloneRef(direction === "apply" ? file.after : file.before),
  }
}

function renameMutations(
  file: ChangeFileRecord,
  direction: ChangeRestoreDirection,
): readonly ChangeRestorePlanMutation[] {
  if (!file.oldPath || !file.targetBase) {
    throw new Error(`Rename change for ${file.path} is incomplete`)
  }
  if (direction === "apply") {
    return [
      {
        changePath: file.path,
        mutationPath: file.oldPath,
        operation: "rename",
        expected: cloneRef(file.applyBase),
        target: cloneRef(ABSENT),
      },
      {
        changePath: file.path,
        mutationPath: file.path,
        operation: "rename",
        expected: cloneRef(file.targetBase),
        target: cloneRef(file.after),
      },
    ]
  }
  return [
    {
      changePath: file.path,
      mutationPath: file.path,
      operation: "rename",
      expected: cloneRef(file.after),
      target: cloneRef(file.targetBase),
    },
    {
      changePath: file.path,
      mutationPath: file.oldPath,
      operation: "rename",
      expected: cloneRef(ABSENT),
      target: cloneRef(file.before),
    },
  ]
}

export function buildChangeSetRestorePlan(
  record: ChangeSetRecord,
  options: BuildChangeSetRestorePlanOptions,
): ChangeSetRestorePlan {
  const bySelectablePath = new Map<string, ChangeFileRecord>()
  for (const file of record.files) {
    bySelectablePath.set(file.path, file)
    if (file.oldPath) bySelectablePath.set(file.oldPath, file)
  }

  const selectedFiles: ChangeFileRecord[] = []
  const selectedLogicalPaths = new Set<string>()
  const requested = options.paths ?? record.files.map((file) => file.path)
  if (requested.length === 0) {
    throw new Error("A restore plan must select at least one path")
  }
  for (const rawPath of requested) {
    const selectedPath = normalizeChangePath(rawPath)
    const file = bySelectablePath.get(selectedPath)
    if (!file) {
      throw new Error(
        `Selected path is not part of change set ${record.id}: ${selectedPath}`,
      )
    }
    if (selectedLogicalPaths.has(file.path)) {
      throw new Error(`Duplicate restore-plan selection: ${selectedPath}`)
    }
    selectedLogicalPaths.add(file.path)
    selectedFiles.push(file)
  }
  selectedFiles.sort((left, right) => left.path.localeCompare(right.path))

  const mutations = selectedFiles.flatMap((file) =>
    file.operation === "rename"
      ? renameMutations(file, options.direction)
      : [ordinaryMutation(file, options.direction)],
  )
  return {
    changeSetId: record.id,
    proposalHash: record.proposalHash,
    direction: options.direction,
    selectedPaths: selectedFiles.map((file) => file.path),
    mutations,
  }
}
