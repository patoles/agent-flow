import type { Agent } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'

export interface CanvasCollision {
  file: string
  /** agent names present in this canvas */
  agents: string[]
  /** true when at least one party in another session is involved too */
  crossSession: boolean
  /** 0..1 freshness, 1 = just happened */
  freshness: number
}

/** Pheromone-style trails between agents that touched the same file inside the collision window */
export function drawCollisions(ctx: CanvasRenderingContext2D, collisions: CanvasCollision[], agents: Map<string, Agent>, time: number) {
  for (const c of collisions) {
    const nodes = c.agents.map(n => agents.get(n)).filter((a): a is Agent => !!a)
    if (nodes.length < 2) continue
    const alpha = 0.25 + 0.6 * c.freshness
    const dash = (time * 40) % 24
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.strokeStyle = COLORS.waiting_permission
    ctx.shadowColor = COLORS.waiting_permission
    ctx.shadowBlur = 10
    ctx.lineWidth = 2
    ctx.setLineDash([10, 14])
    ctx.lineDashOffset = -dash
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        ctx.beginPath()
        ctx.moveTo(nodes[i].x, nodes[i].y)
        ctx.lineTo(nodes[j].x, nodes[j].y)
        ctx.stroke()
      }
    }
    // File label at the centroid
    const cx = nodes.reduce((s, a) => s + a.x, 0) / nodes.length
    const cy = nodes.reduce((s, a) => s + a.y, 0) / nodes.length
    const label = `⚠ ${c.file.split(/[\\/]/).pop()}`
    ctx.setLineDash([])
    ctx.shadowBlur = 0
    ctx.font = '10px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const w = ctx.measureText(label).width + 10
    ctx.fillStyle = 'rgba(2, 6, 14, 0.85)'
    ctx.fillRect(cx - w / 2, cy - 9, w, 18)
    ctx.strokeStyle = COLORS.waiting_permission
    ctx.lineWidth = 1
    ctx.strokeRect(cx - w / 2, cy - 9, w, 18)
    ctx.fillStyle = COLORS.waiting_permission
    ctx.fillText(label, cx, cy)
    ctx.restore()
  }
}
