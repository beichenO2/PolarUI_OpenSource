export const MIN_CANVAS_SCALE = 0.2
export const MAX_CANVAS_SCALE = 4

export interface ViewportTransform {
  scale: number
  offset: { x: number; y: number }
}

export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Normalize wheel deltas to CSS pixels (DOM_DELTA_PIXEL baseline). */
export function normalizeWheelDelta(input: WheelInput): { dx: number; dy: number } {
  let { deltaX, deltaY } = input
  if (input.deltaMode === 1) { // DOM_DELTA_LINE
    deltaX *= 16
    deltaY *= 16
  } else if (input.deltaMode === 2) { // DOM_DELTA_PAGE
    deltaX *= 400
    deltaY *= 400
  }
  return { dx: deltaX, dy: deltaY }
}

export function applyWheelZoom(
  viewport: ViewportTransform,
  deltaY: number,
  anchor: { x: number; y: number },
  opts?: { smooth?: boolean },
): ViewportTransform {
  if (deltaY === 0) return viewport

  let newScale: number
  if (opts?.smooth ?? true) {
    newScale = viewport.scale * Math.exp(-deltaY * 0.002)
  } else {
    const step = 1.1
    newScale = deltaY < 0 ? viewport.scale * step : viewport.scale / step
  }

  newScale = Math.max(MIN_CANVAS_SCALE, Math.min(MAX_CANVAS_SCALE, newScale))
  if (newScale === viewport.scale) return viewport

  const ratio = newScale / viewport.scale
  return {
    scale: newScale,
    offset: {
      x: anchor.x - (anchor.x - viewport.offset.x) * ratio,
      y: anchor.y - (anchor.y - viewport.offset.y) * ratio,
    },
  }
}

/** All wheel events zoom the canvas (proportional to delta — safe on trackpad inertia). */
export function applyWheelToViewport(
  viewport: ViewportTransform,
  input: WheelInput,
  anchor: { x: number; y: number },
): ViewportTransform {
  const { dy } = normalizeWheelDelta(input)
  return applyWheelZoom(viewport, dy, anchor, { smooth: true })
}
