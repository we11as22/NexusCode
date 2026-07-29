import {
  validateQuestionnaireAnswers,
  type UserQuestionAnswer,
  type UserQuestionRequest,
} from "@nexuscode/core"

export interface QuestionResolution {
  accepted: boolean
  request?: UserQuestionRequest
  answers?: UserQuestionAnswer[]
}

export type QuestionClearReason =
  | "session-switch"
  | "dispose"
  | "new-run"
  | "dismiss"
  | "resolved"

export class PendingQuestionCoordinator {
  private pending: UserQuestionRequest | null = null

  publish(request: UserQuestionRequest): void {
    this.pending = request
  }

  resolve(
    requestId: string,
    answers: UserQuestionAnswer[],
  ): QuestionResolution {
    const request = this.pending
    if (!request || request.requestId !== requestId) {
      return { accepted: false }
    }
    const validated = validateQuestionnaireAnswers(request, answers)
    this.pending = null
    return { accepted: true, request, answers: validated }
  }

  dismiss(requestId: string): boolean {
    if (!this.pending || this.pending.requestId !== requestId) return false
    this.clear("dismiss")
    return true
  }

  clear(_reason: QuestionClearReason): void {
    this.pending = null
  }

  snapshot(): UserQuestionRequest | null {
    return this.pending
  }
}
