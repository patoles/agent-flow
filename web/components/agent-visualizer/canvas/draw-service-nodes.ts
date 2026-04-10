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

// ─── Brand SVG Paths (Simple Icons / Bootstrap Icons, viewBox 0 0 24 24) ───
// Sources: simpleicons.org, icons.getbootstrap.com

const ICON_PATHS: Record<string, { d: string; viewBox: number }> = {
  github: {
    viewBox: 24,
    d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  'azure-devops': {
    viewBox: 24,
    d: 'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z',
  },
  azure: {
    viewBox: 24,
    d: 'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z',
  },
  google: {
    viewBox: 24,
    d: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
  },
  gmail: {
    viewBox: 24,
    d: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  },
  slack: {
    viewBox: 16,  // Bootstrap Icons uses 16x16 viewBox
    d: 'M3.362 10.11c0 .926-.756 1.681-1.681 1.681S0 11.036 0 10.111.756 8.43 1.68 8.43h1.682zm.846 0c0-.924.756-1.68 1.681-1.68s1.681.756 1.681 1.68v4.21c0 .924-.756 1.68-1.68 1.68a1.685 1.685 0 0 1-1.682-1.68zM5.89 3.362c-.926 0-1.682-.756-1.682-1.681S4.964 0 5.89 0s1.68.756 1.68 1.68v1.682zm0 .846c.924 0 1.68.756 1.68 1.681S6.814 7.57 5.89 7.57H1.68C.757 7.57 0 6.814 0 5.89c0-.926.756-1.682 1.68-1.682zm6.749 1.682c0-.926.755-1.682 1.68-1.682S16 4.964 16 5.889s-.756 1.681-1.68 1.681h-1.681zm-.848 0c0 .924-.755 1.68-1.68 1.68A1.685 1.685 0 0 1 8.43 5.89V1.68C8.43.757 9.186 0 10.11 0c.926 0 1.681.756 1.681 1.68zm-1.681 6.748c.926 0 1.682.756 1.682 1.681S11.036 16 10.11 16s-1.681-.756-1.681-1.68v-1.682h1.68zm0-.847c-.924 0-1.68-.755-1.68-1.68s.756-1.681 1.68-1.681h4.21c.924 0 1.68.756 1.68 1.68 0 .926-.756 1.681-1.68 1.681z',
  },
}

// ─── Path2D cache ──────────────────────────────────────────────────────────

const pathCache = new Map<string, Path2D>()

function getIconPath(key: string): Path2D | null {
  const cached = pathCache.get(key)
  if (cached) return cached
  const entry = ICON_PATHS[key]
  if (!entry) return null
  const p = new Path2D(entry.d)
  pathCache.set(key, p)
  return p
}

/** Resolve which icon key to use for a given MCP server name */
function resolveIconKey(name: string): string | null {
  if (name.includes('github')) return 'github'
  if (name === 'azure-devops') return 'azure-devops'
  if (name.includes('azure')) return 'azure'
  if (name.includes('google') && !name.includes('gmail')) return 'google'
  if (name.includes('gmail') || name === 'claude_ai_Gmail') return 'gmail'
  if (name.includes('slack') || name === 'claude_ai_Slack') return 'slack'
  return null
}

/** Fallback: draw a simple globe with canvas API */
function drawGlobeFallback(ctx: CanvasRenderingContext2D, s: number) {
  const r = s * 0.55
  ctx.lineWidth = s * 0.08
  ctx.beginPath()
  ctx.arc(0, 0, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(0, 0, r, r * 0.3, 0, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.ellipse(0, 0, r * 0.3, r, 0, 0, Math.PI * 2)
  ctx.stroke()
}

// ─── Main draw function ────────────────────────────────────────────────────

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

    // Brand icon via SVG Path2D, or fallback globe
    const iconKey = resolveIconKey(svc.name)
    const iconPath = iconKey ? getIconPath(iconKey) : null

    if (iconPath && iconKey) {
      const entry = ICON_PATHS[iconKey]
      const vb = entry.viewBox
      const iconSize = r * 0.6
      const iconScale = (iconSize * 2) / vb

      ctx.save()
      ctx.translate(svc.x - iconSize, svc.y - iconSize)
      ctx.scale(iconScale, iconScale)
      ctx.fillStyle = COLORS.serviceText
      ctx.fill(iconPath)
      ctx.restore()
    } else {
      // Fallback: draw globe with canvas API
      ctx.save()
      ctx.translate(svc.x, svc.y)
      ctx.strokeStyle = COLORS.serviceText
      ctx.fillStyle = 'transparent'
      drawGlobeFallback(ctx, r * 0.55)
      ctx.restore()
    }

    // Label: service display name
    const maxLabelW = r * SERVICE_NODE.labelWidthMultiplier
    const labelY = svc.y + r + SERVICE_NODE.labelYOffset

    ctx.textAlign = 'center'
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
