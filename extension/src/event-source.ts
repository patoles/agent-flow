import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent } from './protocol'
import { readNewFileLines } from './fs-utils'

/**
 * Watches a JSONL file for agent events.
 * Each line is a JSON object matching the AgentEvent shape.
 * New lines appended to the file are emitted as events.
 */
export class JsonlEventSource implements vscode.Disposable {
  private watcher: fs.FSWatcher | null = null
  private fileSize = 0
  private readonly _onEvent = new vscode.EventEmitter<AgentEvent>()
  private readonly _onStatus = new vscode.EventEmitter<'connected' | 'disconnected'>()

  readonly onEvent = this._onEvent.event
  readonly onStatus = this._onStatus.event

  constructor(private filePath: string) {}

  start(): void {
    if (!fs.existsSync(this.filePath)) {
      // Create the file if it doesn't exist
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, '')
    }

    // Read existing content
    const stat = fs.statSync(this.filePath)
    this.fileSize = stat.size
    this.processExistingContent()

    // Watch for changes
    this.watcher = fs.watch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        this.readNewLines()
      }
    })

    this._onStatus.fire('connected')
  }

  private processExistingContent(): void {
    const content = fs.readFileSync(this.filePath, 'utf-8')
    const lines = content.split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      const event = this.parseLine(line)
      if (event) {
        this._onEvent.fire(event)
      }
    }
  }

  private readNewLines(): void {
    const result = readNewFileLines(this.filePath, this.fileSize)
    if (!result) return
    this.fileSize = result.newSize
    for (const line of result.lines) {
      const event = this.parseLine(line)
      if (event) {
        this._onEvent.fire(event)
      }
    }
  }

  private parseLine(line: string): AgentEvent | null {
    try {
      const parsed = JSON.parse(line.trim())
      if (parsed && typeof parsed.type === 'string' && typeof parsed.time === 'number') {
        return parsed as AgentEvent
      }
      return null
    } catch {
      return null
    }
  }

  dispose(): void {
    this.watcher?.close()
    this.watcher = null
    this._onEvent.dispose()
    this._onStatus.dispose()
  }
}
