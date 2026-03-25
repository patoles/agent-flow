/**
 * Minimal vscode module shim for running extension code outside VS Code.
 * Only implements what hook-server.ts and session-watcher.ts actually use.
 */
'use strict'

class EventEmitter {
  constructor() { this._listeners = [] }
  get event() {
    return (listener) => {
      this._listeners.push(listener)
      return { dispose: () => { const i = this._listeners.indexOf(listener); if (i >= 0) this._listeners.splice(i, 1) } }
    }
  }
  fire(data) { for (const l of this._listeners) l(data) }
  dispose() { this._listeners = [] }
}

module.exports = {
  EventEmitter,
  workspace: {
    workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
    getConfiguration: () => ({ get: () => undefined }),
  },
  window: {
    showInformationMessage: () => {},
  },
}
