import { AUTONOMOUS_QUESTION_REDIRECT, AUTONOMY_QUESTION_REDIRECT_MARKER } from '../../harness/autonomyPolicy.ts'

/** Host state controls whether a question may open a user dialog. This never
 * chooses an option, invents an answer, or grants permission to another tool. */
export function validateQuestionAutonomy(options: {
  goalState: 'ACTIVE' | 'PAUSED' | 'REVIEW' | null
  permissionMode: string
  worker: boolean
  userQuestions?: boolean
}): { result: true } | { result: false; message: string; errorCode: number } {
  if (options.worker) return {
    result: false,
    errorCode: 2,
    message: AUTONOMY_QUESTION_REDIRECT_MARKER + ' A delegated worker must make routine decisions within its assigned scope. ' +
      'Do not open a user dialog or invent a user answer. Continue available work; if a prerequisite ' +
      'is genuinely missing, return its exact error, diagnostics and required input to the coordinating agent. ' +
      'Do not widen your authority or modify the parent objective.',
  }
  if (options.permissionMode !== 'plan' && options.goalState === 'ACTIVE' && options.userQuestions !== true) return {
    result: false,
    errorCode: 2,
    message: AUTONOMOUS_QUESTION_REDIRECT,
  }
  return { result: true }
}
