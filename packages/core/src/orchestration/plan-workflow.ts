import * as fs from "node:fs/promises"
import * as path from "node:path"

export type PlanWorkflowStatus =
  | "interview"
  | "research"
  | "drafting"
  | "ready"
  | "executing"
  | "completed"

export interface PlanWorkflowQuestion {
  id: string
  question: string
  answer?: string
}

export interface PlanWorkflowRecord {
  id: string
  goal: string
  status: PlanWorkflowStatus
  createdAt: number
  updatedAt: number
  questions: PlanWorkflowQuestion[]
  researchTaskIds: string[]
  planFile?: string
  metadata?: Record<string, unknown>
}

const DEFAULT_QUESTIONS = [
  "What outcome should the implementation achieve for the user?",
  "What constraints or invariants must remain unchanged?",
  "Which code areas or systems are most likely to be affected?",
  "What validation proves the work is complete?",
]

function workflowDir(cwd: string): string {
  return path.join(cwd, ".nexus", "plans", ".workflow")
}

function workflowPath(cwd: string, workflowId: string): string {
  return path.join(workflowDir(cwd), `${workflowId}.json`)
}

function normalizeQuestionId(value: string, index: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return normalized || `question_${index + 1}`
}

function buildQuestions(input?: string[]): PlanWorkflowQuestion[] {
  const source = input?.length ? input : DEFAULT_QUESTIONS
  return source.map((question, index) => ({
    id: normalizeQuestionId(question, index),
    question: question.trim(),
  }))
}

export async function createPlanWorkflow(cwd: string, args: {
  goal: string
  questions?: string[]
  metadata?: Record<string, unknown>
}): Promise<PlanWorkflowRecord> {
  const now = Date.now()
  const record: PlanWorkflowRecord = {
    id: `planwf_${now}_${Math.random().toString(36).slice(2, 8)}`,
    goal: args.goal.trim(),
    status: "interview",
    createdAt: now,
    updatedAt: now,
    questions: buildQuestions(args.questions),
    researchTaskIds: [],
    ...(args.metadata ? { metadata: args.metadata } : {}),
  }
  await fs.mkdir(workflowDir(cwd), { recursive: true })
  await fs.writeFile(workflowPath(cwd, record.id), JSON.stringify(record, null, 2), "utf8")
  return record
}

export async function getPlanWorkflow(cwd: string, workflowId: string): Promise<PlanWorkflowRecord | null> {
  try {
    const raw = await fs.readFile(workflowPath(cwd, workflowId), "utf8")
    return JSON.parse(raw) as PlanWorkflowRecord
  } catch {
    return null
  }
}

export async function listPlanWorkflows(cwd: string): Promise<PlanWorkflowRecord[]> {
  try {
    const entries = await fs.readdir(workflowDir(cwd), { withFileTypes: true })
    const items = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const raw = await fs.readFile(path.join(workflowDir(cwd), entry.name), "utf8")
          return JSON.parse(raw) as PlanWorkflowRecord
        }),
    )
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export async function updatePlanWorkflow(
  cwd: string,
  workflowId: string,
  updater: (current: PlanWorkflowRecord) => PlanWorkflowRecord,
): Promise<PlanWorkflowRecord | null> {
  const current = await getPlanWorkflow(cwd, workflowId)
  if (!current) return null
  const next = {
    ...updater(current),
    updatedAt: Date.now(),
  }
  await fs.mkdir(workflowDir(cwd), { recursive: true })
  await fs.writeFile(workflowPath(cwd, workflowId), JSON.stringify(next, null, 2), "utf8")
  return next
}

export function summarizePlanWorkflow(record: PlanWorkflowRecord): string {
  const answered = record.questions.filter((question) => typeof question.answer === "string" && question.answer.trim()).length
  return [
    `Workflow ${record.id}`,
    `Goal: ${record.goal}`,
    `Status: ${record.status}`,
    `Interview: ${answered}/${record.questions.length} answered`,
    `Research tasks: ${record.researchTaskIds.length}`,
    record.planFile ? `Plan file: ${record.planFile}` : "",
  ].filter(Boolean).join("\n")
}

