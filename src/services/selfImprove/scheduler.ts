/**
 * In-process scheduler for background self-improvement.
 *
 * Armed once per interactive session (see main.tsx). It immediately checks
 * whether a cycle is due, then keeps checking on a cheap timer so
 * long-running sessions keep the loop alive ("keep analyzing" while the
 * session runs). All heavy gating lives in maybeStartSelfImproveCycle —
 * the timer tick is just a nudge, and the ledger guard makes repeated
 * nudges harmless.
 *
 * The timer is unref'd so it never keeps the process alive on its own,
 * and is cleared when the process exits normally.
 */

import { maybeStartSelfImproveCycle } from './cycle.js'

const CHECK_INTERVAL_MS = 60_000

let armed = false
let timer: ReturnType<typeof setInterval> | null = null

/** Arm the background self-improvement loop for this session (idempotent). */
export function armSelfImproveScheduler(): void {
  if (armed) return
  armed = true
  // First check right away (startup/resume of a session is the signal
  // that a session is running).
  void maybeStartSelfImproveCycle({})
  // Then keep nudging while the session is alive.
  timer = setInterval(() => {
    void maybeStartSelfImproveCycle({})
  }, CHECK_INTERVAL_MS)
  timer.unref?.()
}

/** Disarm — used by tests and on clean shutdown. */
export function disarmSelfImproveScheduler(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
  armed = false
}

/** Whether the scheduler is currently armed (test/diagnostics aid). */
export function isSelfImproveSchedulerArmed(): boolean {
  return armed
}
