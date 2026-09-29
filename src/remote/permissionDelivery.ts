export type PermissionDeliveryResult = {
  delivered: string[]
  pending: string[]
}

/**
 * Keeps control responses until the WebSocket has synchronously accepted them.
 * A reconnect may retry the same request_id; the protocol request identity makes
 * that safer than deleting a decision before it has even left this process.
 */
export class PermissionResponseDeliveryQueue<T> {
  private readonly pending = new Map<string, T>()

  enqueue(requestId: string, payload: T): void {
    this.pending.set(requestId, payload)
  }

  has(requestId: string): boolean {
    return this.pending.has(requestId)
  }

  get size(): number {
    return this.pending.size
  }

  cancel(requestId: string): void {
    this.pending.delete(requestId)
  }

  clear(): void {
    this.pending.clear()
  }

  flush(send: (payload: T) => boolean): PermissionDeliveryResult {
    const delivered: string[] = []

    for (const [requestId, payload] of this.pending) {
      let accepted = false
      try {
        accepted = send(payload)
      } catch {
        accepted = false
      }
      if (!accepted) continue

      this.pending.delete(requestId)
      delivered.push(requestId)
    }

    return { delivered, pending: [...this.pending.keys()] }
  }
}
