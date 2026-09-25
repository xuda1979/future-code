/** Trusted adapters use this for errors an unchanged retry cannot repair. */
export class FatalAttemptError extends Error {
  constructor(message: string) { super(message); this.name = "FatalAttemptError"; }
}
