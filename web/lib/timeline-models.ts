import type { TimelineEntry } from './agent-types'
import { formatModelName } from './utils'

/** Record a model on a timeline entry, keeping first-seen order.
 *  Returns the same entry when the model is already recorded. */
export function withTimelineModel(entry: TimelineEntry, model: string): TimelineEntry {
  if (!model || entry.models?.includes(model)) return entry
  return { ...entry, models: [...(entry.models ?? []), model] }
}

/** Display label for an entry's models, e.g. "Opus 5.5 → Fable 5.1".
 *  Ids that format to the same name (like a `[1m]` variant) are shown once. */
export function formatTimelineModels(models: readonly string[] | undefined): string {
  if (!models?.length) return ''
  return [...new Set(models.map(formatModelName))].join(' → ')
}
