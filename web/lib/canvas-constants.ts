// ─── Model context sizes ────────────────────────────────────────────────────

export const MODEL_CONTEXT_SIZES: Record<string, number> = {
  'opus-4-6': 1_000_000,
  'sonnet-4-6': 1_000_000,
}
export const DEFAULT_CONTEXT_SIZE = 200_000
export const FALLBACK_CONTEXT_SIZE = 1_000_000

// ─── Visibility threshold ───────────────────────────────────────────────────

/** Minimum opacity for an element to be considered visible (used for edge/draw culling) */
export const MIN_VISIBLE_OPACITY = 0.05

// ─── Agent spawn distance ───────────────────────────────────────────────────

export const AGENT_SPAWN_DISTANCE = 250

// ─── Tool call dedup window (seconds) ──────────────────────────────────────

export const TOOL_DEDUP_WINDOW_S = 3

// ─── LocalStorage keys ─────────────────────────────────────────────────────

export const SOUND_PREF_KEY = 'agent-viz-sound'

// ─── Mock scenario buffer ──────────────────────────────────────────────────

export const MOCK_END_BUFFER_S = 8

// ─── Canvas drawing constants ────────────────────────────────────────────────

/** Seconds a message bubble stays fully visible */
export const BUBBLE_HOLD = 10
/** Seconds for bubble fade-in animation */
export const BUBBLE_FADE_IN = 0.3
/** Seconds for bubble fade-out animation */
export const BUBBLE_FADE_OUT = 1.5
/** Maximum width (px) of a message bubble */
export const BUBBLE_MAX_W = 220
/** Vertical gap (px) between stacked bubbles */
export const BUBBLE_GAP = 6
/** Max visible lines in a bubble before truncation */
export const BUBBLE_MAX_LINES = 8

/** Tool card width (px) for overlap detection */
export const TOOL_CARD_W = 170
/** Tool card height (px) for overlap detection */
export const TOOL_CARD_H = 36

// ─── Animation timing constants ─────────────────────────────────────────────

/** Seconds a completed tool call stays visible before fading */
export const TOOL_MIN_DISPLAY_S = 4.0
/** Seconds before an orphan running tool fades out */
export const TOOL_MAX_RUNNING_S = 10
/** Seconds a discovery card stays visible before fading */
export const DISCOVERY_HOLD_S = 8
/** Speed multiplier for discovery lerp toward target position */
export const DISCOVERY_LERP_SPEED = 3
/** Seconds a message bubble is considered visible (for pruning) */
export const BUBBLE_VISIBLE_S = 12


// ─── Animation speed multipliers ─────────────────────────────────────────────
// Multiplied by deltaTime in the animation loop

export const ANIM_SPEED = {
  /** Agent fade-in (opacity per dt) */
  agentFadeIn: 3,
  /** Agent scale-in (scale per dt) */
  agentScaleIn: 4,
  /** Agent fade-out after complete (opacity per dt) */
  agentFadeOut: 0.4,
  /** Agent scale-out after complete (scale per dt) */
  agentScaleOut: 0.05,
  /** Tool fade-in (opacity per dt) */
  toolFadeIn: 4,
  /** Tool fade-out after complete/visible (opacity per dt) */
  toolFadeOut: 1.5,
  /** Edge fade-in (opacity per dt) */
  edgeFadeIn: 4,
  /** Discovery fade-in (opacity per dt) */
  discoveryFadeIn: 2,
  /** Discovery fade-out after hold expires (opacity per dt) */
  discoveryFadeOut: 0.5,
  /** Particle speed multiplier */
  particleSpeed: 1.2,
  /** Default delta time cap (seconds) */
  maxDeltaTime: 0.1,
  /** Default delta time when time info unavailable */
  defaultDeltaTime: 0.016,
  /** Minimum ms between frames (60fps cap, with 1ms slack for timing jitter) */
  minFrameInterval: (1000 / 60) - 1,
} as const

// ─── UI panel constants ─────────────────────────────────────────────────────

/** Distance from bottom (px) before a scroll container is considered "at bottom" */
export const AUTO_SCROLL_THRESHOLD = 60

// ─── Camera / interaction constants ─────────────────────────────────────────

export const CAMERA = {
  zoomStepDown: 0.92,
  zoomStepUp: 1.08,
  minZoom: 0.2,
  maxZoom: 4,
  velocityScale: 0.016,
} as const

// ─── Force simulation config ────────────────────────────────────────────────

export const FORCE = {
  chargeStrength: -1200,
  centerStrength: 0.03,
  collideRadius: 140,
  linkDistance: 350,
  linkStrength: 0.4,
  alphaDecay: 0.02,
  velocityDecay: 0.4,
} as const

// ─── Tool slot placement config ─────────────────────────────────────────────

export const TOOL_SLOT = {
  maxRings: 5,
  baseDistance: 100,
  ringIncrement: 35,
  baseSteps: 5,
  stepsPerRing: 2,
  fallbackDistance: 90,
} as const

// ─── Discovery card dimension helpers ───────────────────────────────────────

export const DISC_CHAR_W = 5.5
export const DISC_LABEL_CHAR_W = 6
export const DISC_MIN_W = 80
export const DISC_MAX_W = 150
export const DISC_PADDING = 16
export const DISC_HEADER_H = 16
export const DISC_LINE_H = 11

/** Half-width used for discovery card bounding box in auto-fit calculations */
export const DISC_BOUNDS_HALF_W = 80
/** Half-height used for discovery card bounding box in auto-fit calculations */
export const DISC_BOUNDS_HALF_H = 30

export function getDiscoveryCardDimensions(label: string, contentLines: string[]) {
  const maxLineWidth = Math.max(...contentLines.map(l => l.length * DISC_CHAR_W), label.length * DISC_LABEL_CHAR_W)
  const cardW = Math.min(Math.max(DISC_MIN_W, maxLineWidth + DISC_PADDING), DISC_MAX_W)
  const cardH = DISC_HEADER_H + contentLines.length * DISC_LINE_H
  return { cardW, cardH }
}

// ─── Tool card dimension constant ───────────────────────────────────────────

export const TOOL_MAX_CARD_W = 160

/** Blended $/M-token rate for Sonnet-class models */
export const COST_RATE = 6

// ─── Agent drawing constants ────────────────────────────────────────────────

export const AGENT_DRAW = {
  /** Offset from agent center to bubble anchor point */
  bubbleAnchorOffset: 14,
  /** Initial cursor Y offset for bubbles */
  bubbleCursorY: -20,
  /** Outer glow extra radius beyond agent radius */
  glowPadding: 20,
  /** Ambient outer hex ring offset from agent radius */
  outerRingOffset: 3,
  /** Shadow blur for depth shadow */
  shadowBlur: 15,
  shadowOffsetX: 3,
  shadowOffsetY: 5,
  /** Agent name label Y offset from agent radius */
  labelYOffset: 8,
  /** Agent name label width multiplier of radius */
  labelWidthMultiplier: 3,
  /** Scanline gradient half-height */
  scanlineHalfH: 4,
  /** Scanline width = 2 * scanlineHalfH */
  scanlineWidth: 8,
  /** Dash offset animation speed for waiting state */
  waitingDashSpeed: 25,
  /** Orbiting particle offset from radius */
  orbitParticleOffset: 12,
  orbitParticleSize: 1.5,
  /** Waiting state ripple inner offset from radius */
  rippleInnerOffset: 5,
  rippleMaxExpand: 45,
  rippleMaxAlpha: 0.4,
  /** Waiting state orbiting particle offset */
  waitingOrbitOffset: 14,
  waitingOrbitParticleSize: 2,
  waitingOrbitSpeed: 0.8,
  /** Waiting state breathe parameters */
  waitingBreatheSpeed: 1.2,
  waitingBreatheAmp: 0.08,
  /** Claude spark logo scale factor (relative to radius / SVG viewBox) */
  sparkScale: 0.45,
  /** SVG viewBox size for Claude spark path */
  sparkViewBox: 256,
  /** Sub-agent icon font size relative to radius */
  subIconScale: 0.45,
} as const

export const CONTEXT_BAR = {
  /** Minimum bar width */
  minWidth: 60,
  /** Bar width multiplier of radius */
  widthMultiplier: 2.2,
  barHeight: 6,
  /** Y offset from agent radius */
  yOffset: 22,
  borderRadius: 3,
  /** Font for token count label */
  fontSize: 7,
  /** Y padding below bar for label */
  labelPadding: 9,
} as const

export const CONTEXT_RING = {
  /** Ring offset from agent radius */
  ringOffset: 8,
  ringWidth: 4,
  /** Warning threshold ratios */
  warningThreshold: 0.8,
  criticalThreshold: 0.9,
  /** Show percentage label above this usage ratio */
  percentLabelThreshold: 0.7,
  /** Warning glow extra radius */
  glowPadding: 4,
  glowLineWidth: 2,
  glowBlur: 12,
  /** Percentage label Y offset from radius */
  percentYOffset: 10,
} as const

export const STATS_OVERLAY = {
  /** Y offset above agent radius */
  yOffset: 25,
  boxWidth: 70,
  boxHeight: 18,
  borderRadius: 3,
  fontSize: 8,
  textPaddingY: 4,
} as const

// ─── Tool card drawing constants ────────────────────────────────────────────

export const TOOL_DRAW = {
  fontSize: 8,
  borderRadius: 4,
  /** Extra height for completed/error cards showing token cost */
  expandedHeight: 30,
  collapsedHeight: 24,
  /** Error glow base blur + pulse amplitude */
  errorGlowBase: 8,
  errorGlowPulse: 4,
  /** Spinning ring extra radius beyond card half-size */
  spinRingPadding: 4,
  spinSpeed: 3,
  spinArc: Math.PI * 1.2,
  /** Error detail font size */
  errorFontSize: 6,
  /** Token cost font size */
  tokenFontSize: 6,
  /** Y offset for two-line card layout */
  twoLineOffset: 5,
} as const

// ─── Cost overlay drawing constants ─────────────────────────────────────────

export const COST_DRAW = {
  /** Minimum cost to display label */
  minDisplayCost: 0.0001,
  /** Cost pill Y offset above agent radius */
  pillYOffset: 22,
  pillPadding: 12,
  pillHeight: 16,
  pillRadius: 8,
  /** Mini bar height below cost pill */
  miniBarHeight: 3,
  miniBarRadius: 1.5,
  miniBarGap: 3,
  miniBarMaxExtra: 10,
  miniBarMax: 80,
} as const

export const COST_PANEL = {
  width: 200,
  /** X margin from right edge */
  xMargin: 16,
  /** Y position (below top bar) */
  yStart: 48,
  lineHeight: 16,
  headerHeight: 28,
  sectionGap: 8,
  maxRows: 5,
  borderRadius: 8,
  contentPadding: 10,
  barInset: 4,
  barRadius: 3,
} as const

// ─── Bubble drawing constants ───────────────────────────────────────────────

export const BUBBLE_DRAW = {
  thinking: { fontSize: 5.5, labelSize: 5, lineH: 7.5, padding: 5, headerH: 10 },
  normal: { fontSize: 7, labelSize: 6, lineH: 10, padding: 6, headerH: 12 },
  /** Triangle pointer offsets */
  triOffset: 4,
  triWidth: 5,
  /** Border radius for bubble rounded rectangles */
  borderRadius: 5,
} as const

// ─── Effect drawing constants ───────────────────────────────────────────────

export const SPAWN_FX = {
  ringStart: 10,
  ringExpand: 60,
  maxAlpha: 0.7,
  flashThreshold: 0.3,
  flashAlpha: 0.6,
  flashBaseRadius: 20,
  flashMinRadius: 5,
  particleCount: 8,
  particleSize: 1.5,
} as const

export const COMPLETE_FX = {
  ringStart: 20,
  ringExpand: 80,
  maxAlpha: 0.6,
  flashThreshold: 0.2,
  flashAlpha: 0.8,
  flashRadius: 30,
  lineWidthMax: 3,
  glowInner: 5,
  glowOuter: 10,
} as const

// ─── Particle drawing constants ─────────────────────────────────────────────

export const PARTICLE_DRAW = {
  glowRadius: 15,
  coreHighlightScale: 0.4,
  labelMinT: 0.2,
  labelMaxT: 0.8,
  labelFontSize: 8,
  labelYOffset: -12,
} as const

// ─── Performance overlay constants (debug only, ?perf or ?stress) ────────────

/** Cached once at module load — avoids parsing location.search every frame */
export const PERF_OVERLAY_ENABLED = typeof window !== 'undefined'
  && (() => {
    const p = new URLSearchParams(window.location.search)
    return p.has('perf') || p.has('stress')
  })()

export const PERF_OVERLAY = {
  x: 8,
  y: 8,
  width: 260,
  height: 140,
  padding: 8,
  lineHeight: 18,
  font: '12px monospace',
  maxFrameSamples: 120,
  fpsWarning: 30,
  fpsCaution: 50,
  updateIntervalMs: 1000,
  bgColor: 'rgba(0, 0, 0, 0.75)',
  fpsGoodColor: '#44ff44',
  fpsCautionColor: '#ffaa00',
  fpsWarningColor: '#ff4444',
  textColor: '#cccccc',
} as const

// ─── Hit detection constants ────────────────────────────────────────────────

export const HIT_DETECTION = {
  /** Estimated character width for tool card labels */
  toolCharWidth: 4.5,
  /** Estimated character width for bubble text */
  bubbleCharWidth: 4.2,
  /** Tool card expanded height (with result) */
  toolExpandedH: 34,
  toolCollapsedH: 24,
} as const

