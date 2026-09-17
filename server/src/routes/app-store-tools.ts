// The assistant's window onto App Store Connect: one read-only tool that
// answers "how are my apps doing" from the numbers app-store.ts has gathered.
//
// Offered whether or not a key is configured — unlike the Plex or drawing
// tools there is nothing here that can fail loudly after promising: with no
// key the answer is a sentence saying where to set it up, which is the
// honest reply to the question.

import { appStoreConfigured, appStoreView, proceedsText, type AppView, type PeriodTotals } from '../app-store'

export const APP_STORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'app_store_stats',
      description:
        "How the user's own apps are doing on Apple's App Store: downloads, money earned, " +
        'impressions and product page views, from App Store Connect. Use for "how is Sudoku doing", ' +
        '"how many downloads did my apps get this week", "what did my apps earn this month", ' +
        '"how many people saw my app". The numbers run a day behind — Apple publishes each day the ' +
        'next morning — so "today" means yesterday.',
      parameters: {
        type: 'object',
        properties: {
          app:    { type: 'string', description: 'An app name if they asked about one; empty for every app.' },
          period: {
            type: 'string', enum: ['yesterday', 'week', 'month'],
            description: 'Which stretch: yesterday, the last 7 days (the default), or the last 30 days.',
          },
        },
      },
    },
  },
]

function n(v: number | null): string {
  return v === null ? 'no figure yet' : v.toLocaleString('en-US')
}

function periodWords(period: 'yesterday' | 'week' | 'month'): string {
  return period === 'yesterday' ? 'yesterday' : period === 'week' ? 'over the last 7 days' : 'over the last 30 days'
}

function describe(app: AppView, period: 'yesterday' | 'week' | 'month', currency: string | null): string {
  const t: PeriodTotals = app.periods[period]
  const prev = period === 'week' ? app.periods.prevWeek : period === 'month' ? app.periods.prevMonth : null
  const parts: string[] = []
  parts.push(`${n(t.downloads)} download${t.downloads === 1 ? '' : 's'}${prev ? ` (${n(prev.downloads)} the ${period} before)` : ''}`)
  if (t.updates) parts.push(`${n(t.updates)} updates`)
  if (t.iap) parts.push(`${n(t.iap)} in-app purchases`)
  parts.push(`earned ${proceedsText(t.proceeds, currency)}`)
  if (t.impressions !== null) parts.push(`${n(t.impressions)} impressions`)
  if (t.pageViews !== null) parts.push(`${n(t.pageViews)} product page views`)
  if (t.sessions !== null) parts.push(`${n(t.sessions)} sessions`)
  if (t.crashes) parts.push(`${n(t.crashes)} crashes`)
  return `${app.name}: ${parts.join(', ')}.`
}

/** Text for the model, or null when the tool is not ours. */
export function runAppStoreTool(name: string, args: Record<string, unknown>): string | null {
  if (name !== 'app_store_stats') return null
  if (!appStoreConfigured()) {
    return 'App Store Connect is not set up yet. The key goes in Settings → Apps on the dashboard; until then there are no figures.'
  }
  const view = appStoreView()
  const wanted = typeof args['app'] === 'string' ? args['app'].trim().toLowerCase() : ''
  const period = args['period'] === 'yesterday' || args['period'] === 'month' ? args['period'] : 'week'
  let apps = view.apps
  if (wanted) {
    const match = apps.filter(a => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase()))
    if (match.length === 0) {
      return `No app called "${args['app']}" — the apps are ${apps.map(a => a.name).join(', ') || 'none yet'}.`
    }
    apps = match
  }
  if (apps.length === 0) {
    return view.lastRun
      ? (view.lastRun.ok ? 'Apple has not listed any apps for this account yet.' : `The last read from Apple failed: ${view.lastRun.detail}`)
      : 'The first read from Apple has not run yet — try again in a minute.'
  }
  const lines = apps.map(a => describe(a, period, view.currency))
  const lag = apps.some(a => a.latestAnalyticsDay === null)
    ? ' Impressions and page views start arriving a day or two after the key is set up.'
    : ''
  return `App Store figures ${periodWords(period)}, up to ${view.asOf} (Apple publishes a day late):\n${lines.join('\n')}${lag}`
}
