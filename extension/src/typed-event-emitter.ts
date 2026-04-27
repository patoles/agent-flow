/**
 * Minimal typed event emitter.
 *
 * Mirrors the surface of vscode.EventEmitter so watchers can be used both
 * inside the VS Code extension host and in the standalone relay (Node-only,
 * no vscode module available).
 */

export interface TypedDisposable {
  dispose(): void
}

export type TypedEvent<T> = (listener: (data: T) => void) => TypedDisposable

export class TypedEventEmitter<T> implements TypedDisposable {
  private listeners: Array<(data: T) => void> = []
  private disposed = false

  readonly event: TypedEvent<T> = (listener) => {
    // Subscribing after dispose is almost always a lifecycle bug — the caller
    // would never receive events. Return a no-op disposable so the caller
    // doesn't blow up, but refuse to retain the listener.
    if (this.disposed) return { dispose: () => {} }
    this.listeners.push(listener)
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener)
        if (idx >= 0) this.listeners.splice(idx, 1)
      },
    }
  }

  fire(data: T): void {
    if (this.disposed) return
    // Snapshot so a listener mutating the list mid-fire doesn't affect this round.
    for (const l of [...this.listeners]) l(data)
  }

  dispose(): void {
    this.disposed = true
    this.listeners = []
  }
}
