import { randomUUID } from "node:crypto"
import { Worker } from "node:worker_threads"

import type { Mode, ToolResult } from "../../types.js"

const WORKER_SOURCE = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");

const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_METADATA_CHARS = 256 * 1024;
const MAX_DESCRIPTORS = 256;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_CHARS = 8 * 1024 * 1024;
const functions = new Map();
const controllers = new Map();

function errorPayload(error) {
  return {
    name: error && typeof error.name === "string" ? error.name.slice(0, 128) : "Error",
    message: error && typeof error.message === "string"
      ? error.message.slice(0, 16 * 1024)
      : String(error).slice(0, 16 * 1024),
    stack: error && typeof error.stack === "string"
      ? error.stack.slice(0, 32 * 1024)
      : undefined,
  };
}

function assertJson(value, label, maxChars) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error(label + " must be JSON-serializable");
  }
  if (encoded === undefined) throw new Error(label + " must be JSON-serializable");
  if (encoded.length > maxChars) {
    throw new Error(label + " exceeded " + maxChars + " encoded characters");
  }
  return JSON.parse(encoded);
}

function normalizeResult(raw) {
  if (typeof raw === "string") {
    if (raw.length > MAX_OUTPUT_CHARS) {
      throw new Error("Custom tool output exceeded " + MAX_OUTPUT_CHARS + " characters");
    }
    return { success: true, output: raw };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Custom tool must return a string or a ToolResult object");
  }
  if (typeof raw.output !== "string") {
    throw new Error("Custom tool result.output must be a string");
  }
  if (raw.output.length > MAX_OUTPUT_CHARS) {
    throw new Error("Custom tool output exceeded " + MAX_OUTPUT_CHARS + " characters");
  }
  const result = {
    success: raw.success === undefined ? true : raw.success,
    output: raw.output,
  };
  if (typeof result.success !== "boolean") {
    throw new Error("Custom tool result.success must be a boolean");
  }
  if (raw.metadata !== undefined) {
    result.metadata = assertJson(raw.metadata, "Custom tool metadata", MAX_METADATA_CHARS);
  }
  if (raw.attachments !== undefined) {
    if (!Array.isArray(raw.attachments) || raw.attachments.length > MAX_ATTACHMENTS) {
      throw new Error("Custom tool attachments exceeded " + MAX_ATTACHMENTS + " items");
    }
    let total = 0;
    result.attachments = raw.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        throw new Error("Custom tool attachment must be an object");
      }
      if (!["image", "diff", "file"].includes(attachment.type)) {
        throw new Error("Custom tool attachment.type is invalid");
      }
      if (typeof attachment.content !== "string") {
        throw new Error("Custom tool attachment.content must be a string");
      }
      if (attachment.content.length > MAX_ATTACHMENT_CHARS) {
        throw new Error("Custom tool attachment exceeded " + MAX_ATTACHMENT_CHARS + " characters");
      }
      total += attachment.content.length;
      if (total > MAX_TOTAL_ATTACHMENT_CHARS) {
        throw new Error(
          "Custom tool attachments exceeded " + MAX_TOTAL_ATTACHMENT_CHARS + " total characters",
        );
      }
      return {
        type: attachment.type,
        content: attachment.content,
        ...(typeof attachment.mimeType === "string"
          ? { mimeType: attachment.mimeType.slice(0, 256) }
          : {}),
      };
    });
  }
  return result;
}

function descriptorFor(exportId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.execute !== "function") return null;
  if (typeof value.name !== "string") {
    throw new Error("Tool export " + exportId + " is missing a string name");
  }
  if (value.name.length > 256) {
    throw new Error("Tool export " + exportId + " name is too large");
  }
  if (typeof value.description !== "string") {
    throw new Error("Tool export " + exportId + " is missing a string description");
  }
  if (value.description.length > 4096) {
    throw new Error("Tool export " + exportId + " description is too large");
  }
  if (!value.inputSchema || typeof value.inputSchema !== "object" || Array.isArray(value.inputSchema)) {
    throw new Error("Tool export " + exportId + " is missing an object inputSchema");
  }
  functions.set(exportId, value.execute);
  if (value.searchHint !== undefined &&
      (typeof value.searchHint !== "string" || value.searchHint.length > 2048)) {
    throw new Error("Tool export " + exportId + " searchHint is invalid");
  }
  if (value.modes !== undefined &&
      (!Array.isArray(value.modes) || value.modes.length > 8 ||
       value.modes.some((mode) => typeof mode !== "string" || mode.length > 32))) {
    throw new Error("Tool export " + exportId + " modes are invalid");
  }
  return {
    exportId,
    name: value.name,
    description: value.description,
    inputSchema: assertJson(value.inputSchema, "Custom tool inputSchema", 256 * 1024),
    ...(typeof value.searchHint === "string" ? { searchHint: value.searchHint } : {}),
    ...(typeof value.shouldDefer === "boolean" ? { shouldDefer: value.shouldDefer } : {}),
    ...(typeof value.readOnly === "boolean" ? { declaredReadOnly: value.readOnly } : {}),
    ...(Array.isArray(value.modes) ? { modes: value.modes } : {}),
  };
}

async function load() {
  const url = pathToFileURL(workerData.modulePath).href + "?generation=" +
    encodeURIComponent(workerData.generation);
  const mod = await import(url);
  const descriptors = [];
  const defaults = Array.isArray(mod.default) ? mod.default : [mod.default];
  for (let index = 0; index < defaults.length; index += 1) {
    const descriptor = descriptorFor("default:" + index, defaults[index]);
    if (descriptor) {
      descriptors.push(descriptor);
      if (descriptors.length > MAX_DESCRIPTORS) {
        throw new Error("Module exceeded " + MAX_DESCRIPTORS + " tool descriptors");
      }
    }
  }
  for (const [name, value] of Object.entries(mod)) {
    if (name === "default") continue;
    const descriptor = descriptorFor("named:" + name, value);
    if (descriptor) {
      descriptors.push(descriptor);
      if (descriptors.length > MAX_DESCRIPTORS) {
        throw new Error("Module exceeded " + MAX_DESCRIPTORS + " tool descriptors");
      }
    }
  }
  if (descriptors.length === 0) {
    throw new Error("Module exported no custom tool descriptors");
  }
  parentPort.postMessage({ type: "ready", descriptors });
}

parentPort.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "abort") {
    controllers.get(message.callId)?.abort();
    return;
  }
  if (message.type !== "call") return;
  const execute = functions.get(message.exportId);
  if (!execute) {
    parentPort.postMessage({
      type: "result",
      callId: message.callId,
      ok: false,
      error: { name: "Error", message: "Unknown custom tool export" },
    });
    return;
  }
  const controller = new AbortController();
  controllers.set(message.callId, controller);
  try {
    const raw = await execute(message.args, {
      cwd: message.context.cwd,
      mode: message.context.mode,
      signal: controller.signal,
    });
    parentPort.postMessage({
      type: "result",
      callId: message.callId,
      ok: true,
      result: normalizeResult(raw),
    });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      callId: message.callId,
      ok: false,
      error: errorPayload(error),
    });
  } finally {
    controllers.delete(message.callId);
  }
});

load().catch((error) => {
  parentPort.postMessage({ type: "load-error", error: errorPayload(error) });
});
`

export interface IsolatedToolDescriptor {
  exportId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  searchHint?: string
  shouldDefer?: boolean
  declaredReadOnly?: boolean
  modes?: unknown[]
}

export interface IsolatedToolCallContext {
  cwd: string
  mode?: Mode
  signal: AbortSignal
}

export interface IsolatedToolModuleOptions {
  generation: string
  loadTimeoutMs: number
  callTimeoutMs: number
}

interface WorkerErrorPayload {
  name?: string
  message?: string
  stack?: string
}

interface PendingCall {
  resolve(result: ToolResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  removeAbortListener: () => void
}

export class CustomToolWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CustomToolWorkerError"
  }
}

function boundedCallArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  let encoded: string
  try {
    encoded = JSON.stringify(args)
  } catch (error) {
    throw new CustomToolWorkerError(
      "Custom tool input must be JSON-serializable",
      { cause: error },
    )
  }
  const maxInputChars = 1024 * 1024
  if (encoded.length > maxInputChars) {
    throw new CustomToolWorkerError(
      `Custom tool input exceeded ${maxInputChars} encoded characters`,
    )
  }
  const parsed = JSON.parse(encoded) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CustomToolWorkerError(
      "Custom tool input must be a JSON object",
    )
  }
  return parsed as Record<string, unknown>
}

function workerError(
  prefix: string,
  payload?: WorkerErrorPayload,
): CustomToolWorkerError {
  const detail = payload?.message?.trim()
  const error = new CustomToolWorkerError(
    detail ? `${prefix}: ${detail}` : prefix,
  )
  if (payload?.stack) error.stack = payload.stack
  return error
}

export class IsolatedToolModule {
  private readonly worker: Worker
  private readonly pending = new Map<string, PendingCall>()
  private closed = false
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly modulePath: string,
    private readonly options: IsolatedToolModuleOptions,
    worker: Worker,
  ) {
    this.worker = worker
  }

  static async load(
    modulePath: string,
    options: IsolatedToolModuleOptions,
  ): Promise<{ runtime: IsolatedToolModule; descriptors: IsolatedToolDescriptor[] }> {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: {
        modulePath,
        generation: options.generation,
      },
      env: {
        NODE_NO_WARNINGS: "1",
      },
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    })
    const runtime = new IsolatedToolModule(modulePath, options, worker)
    try {
      const descriptors = await runtime.awaitReady()
      return { runtime, descriptors }
    } catch (error) {
      await runtime.close()
      throw error
    }
  }

  private awaitReady(): Promise<IsolatedToolDescriptor[]> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        result:
          | { ok: true; descriptors: IsolatedToolDescriptor[] }
          | { ok: false; error: Error },
      ) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.worker.off("message", onMessage)
        this.worker.off("error", onError)
        this.worker.off("exit", onExit)
        this.attachRuntimeListeners()
        if (result.ok) resolve(result.descriptors)
        else reject(result.error)
      }
      const onMessage = (message: unknown) => {
        const value = message as {
          type?: string
          descriptors?: IsolatedToolDescriptor[]
          error?: WorkerErrorPayload
        }
        if (value?.type === "ready" && Array.isArray(value.descriptors)) {
          finish({ ok: true, descriptors: value.descriptors })
        } else if (value?.type === "load-error") {
          finish({
            ok: false,
            error: workerError("Custom tool worker failed to load", value.error),
          })
        }
      }
      const onError = (error: Error) =>
        finish({
          ok: false,
          error: new CustomToolWorkerError(
            `Custom tool worker crashed while loading ${this.modulePath}`,
            { cause: error },
          ),
        })
      const onExit = (code: number) =>
        finish({
          ok: false,
          error: new CustomToolWorkerError(
            `Custom tool worker exited with code ${code} while loading`,
          ),
        })
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            error: new CustomToolWorkerError(
              `Custom tool worker load timed out after ${this.options.loadTimeoutMs}ms`,
            ),
          }),
        this.options.loadTimeoutMs,
      )
      timer.unref?.()
      this.worker.on("message", onMessage)
      this.worker.once("error", onError)
      this.worker.once("exit", onExit)
    })
  }

  private attachRuntimeListeners(): void {
    this.worker.on("message", (message: unknown) => {
      const value = message as {
        type?: string
        callId?: string
        ok?: boolean
        result?: ToolResult
        error?: WorkerErrorPayload
      }
      if (value?.type !== "result" || typeof value.callId !== "string") return
      const pending = this.pending.get(value.callId)
      if (!pending) return
      this.pending.delete(value.callId)
      clearTimeout(pending.timer)
      pending.removeAbortListener()
      if (value.ok === true && value.result) pending.resolve(value.result)
      else {
        pending.reject(
          workerError("Custom tool execution failed", value.error),
        )
      }
    })
    this.worker.once("error", (error) => {
      void this.fail(
        new CustomToolWorkerError("Custom tool worker crashed", {
          cause: error,
        }),
      )
    })
    this.worker.once("exit", (code) => {
      if (this.closed) return
      void this.fail(
        new CustomToolWorkerError(
          `Custom tool worker exited with code ${code}`,
        ),
      )
    })
  }

  async call(
    exportId: string,
    args: Record<string, unknown>,
    context: IsolatedToolCallContext,
  ): Promise<ToolResult> {
    if (this.closed) {
      throw new CustomToolWorkerError("Custom tool worker is closed")
    }
    if (context.signal.aborted) {
      throw new CustomToolWorkerError("Custom tool call was aborted")
    }
    const boundedArgs = boundedCallArguments(args)
    const callId = randomUUID()
    return new Promise<ToolResult>((resolve, reject) => {
      const abort = () => {
        this.worker.postMessage({ type: "abort", callId })
        void this.fail(
          new CustomToolWorkerError("Custom tool call was aborted"),
        )
      }
      context.signal.addEventListener("abort", abort, { once: true })
      const timer = setTimeout(() => {
        void this.fail(
          new CustomToolWorkerError(
            `Custom tool call timed out after ${this.options.callTimeoutMs}ms`,
          ),
        )
      }, this.options.callTimeoutMs)
      timer.unref?.()
      this.pending.set(callId, {
        resolve,
        reject,
        timer,
        removeAbortListener: () =>
          context.signal.removeEventListener("abort", abort),
      })
      try {
        this.worker.postMessage({
          type: "call",
          callId,
          exportId,
          args: boundedArgs,
          context: {
            cwd: context.cwd,
            mode: context.mode,
          },
        })
      } catch (error) {
        void this.fail(
          new CustomToolWorkerError(
            "Failed to send a custom tool call to its worker",
            { cause: error },
          ),
        )
      }
    })
  }

  private async fail(error: Error): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbortListener()
      pending.reject(error)
    }
    this.pending.clear()
    await this.terminateWorker()
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closed = true
    const error = new CustomToolWorkerError("Custom tool worker is closed")
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbortListener()
      pending.reject(error)
    }
    this.pending.clear()
    this.closePromise = this.terminateWorker()
    return this.closePromise
  }

  private async terminateWorker(): Promise<void> {
    await this.worker.terminate().then(
      () => undefined,
      () => undefined,
    )
  }
}
