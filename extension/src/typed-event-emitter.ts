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

  readonly event: TypedEvent<T> = (listener) => {
    this.listeners.push(listener)
    return {
      dispose: () => {
        const idx = this.listeners.indexOf(listener)
        if (idx >= 0) this.listeners.splice(idx, 1)
      },
    }
  }

  fire(data: T): void {
    // Snapshot so a listener mutating the list mid-fire doesn't affect this round.
    for (const l of [...this.listeners]) l(data)
  }

  dispose(): void {
    this.listeners = []
  }
}
