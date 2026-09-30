export type PermissionDeliveryResult = {
  delivered: string[]
  retained: string[]
}

/**
 * Retains control responses through reconnects.
 *
 * A WebSocket send only proves that the local socket accepted bytes; it does
 * not prove the remote process consumed them before a disconnect. Keeping the
 * decision keyed by request_id lets reconnect replay the exact same response.
 * Entries are removed only when the server cancels the request or the session
 * is torn down.
 */
export class PermissionResponseDeliveryQueue<T> {
  private readonly retained = new Map<string, T>()

  enqueue(requestId: string, payload: T): void {
    this.retained.set(requestId, payload)
  }

  has(requestId: string): boolean {
    return this.retained.has(requestId)
  }

  get size(): number {
    return this.retained.size
  }

  cancel(requestId: string): void {
    this.retained.delete(requestId)
  }

  clear(): void {
    this.retained.clear()
  }

  flush(send: (payload: T) => boolean): PermissionDeliveryResult {
    const delivered: string[] = []

    for (const [requestId, payload] of this.retained) {
      let accepted = false
      try {
        accepted = send(payload)
      } catch {
        accepted = false
      }
      if (accepted) delivered.push(requestId)
    }

    return { delivered, retained: [...this.retained.keys()] }
  }
}
