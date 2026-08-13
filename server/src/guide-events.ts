// One place that tells every connected dashboard a guide changed.
//
// Three callers need this — the generator (after each section), the voice tools
// (after a tick), and the REST route (so a second screen stays in step) — and
// they can't import it from each other without a cycle, so it lives on its own.
//
// The payload is deliberately everything a summary row draws, so the client can
// patch its state from the event instead of refetching on every section.

import { guideProgress, type Guide } from './guides'
import { broadcast } from './routes/system'

export function pushGuide(guide: Guide): void {
  const p = guideProgress(guide)
  broadcast('guide', {
    itemId:   guide.itemId,
    status:   guide.status,
    percent:  p.percent,
    ...(guide.phase ? { phase: guide.phase } : {}),
    title:    guide.title,
    sections: guide.sections.length,
  })
}
