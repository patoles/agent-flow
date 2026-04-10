import { ServiceNode } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { SERVICE_NODE } from '@/lib/canvas-constants'
import { truncateText } from './draw-misc'

/** Draw a hexagonal path centered at (cx, cy) with given radius */
function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath()
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 6
    const x = cx + r * Math.cos(angle)
    const y = cy + r * Math.sin(angle)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** Map well-known MCP server names to icons */
function serviceIcon(name: string): string {
  if (name.includes('github')) return '\u{1F4BB}'     // laptop
  if (name.includes('azure')) return '\u{2601}'       // cloud
  if (name.includes('google')) return '\u{1F4E7}'     // envelope
  if (name.includes('slack')) return '\u{1F4AC}'      // speech bubble
  if (name.includes('gmail')) return '\u{2709}'       // envelope
  if (name.includes('mercadopago')) return '\u{1F4B3}' // credit card
  return '\u{1F310}'                                   // globe
}

export function drawServiceNodes(
  ctx: CanvasRenderingContext2D,
  serviceNodes: Map<string, ServiceNode>,
  time: number,
) {
  for (const [, svc] of serviceNodes) {
    if (svc.opacity <= 0) continue

    const r = SERVICE_NODE.radius * svc.scale
    const isActive = svc.activeCalls > 0
    const pulse = isActive
      ? Math.sin(time * SERVICE_NODE.pulseSpeed) * 0.15 + 0.85
      : 1

    ctx.save()
    ctx.globalAlpha = svc.opacity

    // Outer glow when active
    if (isActive) {
      ctx.shadowColor = COLORS.serviceGlow
      ctx.shadowBlur = SERVICE_NODE.glowPadding * pulse
    }

    // Hexagonal body
    hexPath(ctx, svc.x, svc.y, r)
    ctx.fillStyle = `rgba(40, 15, 35, ${0.7 * pulse})`
    ctx.fill()
    ctx.strokeStyle = isActive ? COLORS.service : COLORS.serviceDim
    ctx.lineWidth = isActive ? 2 : 1
    ctx.stroke()

    ctx.shadowBlur = 0

    // Inner hex ring (decorative)
    hexPath(ctx, svc.x, svc.y, r * 0.75)
    ctx.strokeStyle = COLORS.service + '30'
    ctx.lineWidth = 0.5
    ctx.stroke()

    // Icon
    ctx.font = `${SERVICE_NODE.iconFontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(serviceIcon(svc.name), svc.x, svc.y)

    // Label: service display name
    const maxLabelW = r * SERVICE_NODE.labelWidthMultiplier
    const labelY = svc.y + r + SERVICE_NODE.labelYOffset

    ctx.font = 'bold 9px monospace'
    ctx.fillStyle = COLORS.serviceText
    ctx.textBaseline = 'top'
    ctx.fillText(truncateText(ctx, svc.displayName, maxLabelW), svc.x, labelY)

    // Stats: call count
    const statsY = labelY + SERVICE_NODE.statsYOffset
    ctx.font = `${SERVICE_NODE.statsFontSize}px monospace`
    ctx.fillStyle = COLORS.serviceDim
    const statsText = svc.activeCalls > 0
      ? `${svc.totalCalls} calls (${svc.activeCalls} active)`
      : `${svc.totalCalls} calls`
    ctx.fillText(truncateText(ctx, statsText, maxLabelW), svc.x, statsY)

    ctx.restore()
  }
}
