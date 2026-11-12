// The assistant's window onto App Store Connect: one read-only tool that
// answers "how are my apps doing" from the numbers app-store.ts has gathered.
//
// Offered whether or not a key is configured — unlike the Plex or drawing
// tools there is nothing here that can fail loudly after promising: with no
// key the answer is a sentence saying where to set it up, which is the
// honest reply to the question.

import { addDays, appStoreConfigured, latestDay } from '../app-store'
import { adsConfigured } from '../ads'
import { buildReport, type Measures } from '../app-report'

export const APP_STORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'app_store_stats',
      description:
        "How the user's own apps are doing: App Store downloads, money earned from sales, what the " +
        'ads in them earned (AdMob, Unity Ads), impressions and product page views. Use for "how is Sudoku doing", ' +
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

type Period = 'yesterday' | 'week' | 'month'

function periodWords(period: Period): string {
  return period === 'yesterday' ? 'yesterday' : period === 'week' ? 'over the last 7 days' : 'over the last 30 days'
}

function describe(name: string, t: Measures, prev: Measures | null, period: Period, currency: string): string {
  const cash = (v: number) => `${v.toFixed(2)} ${currency}`
  const parts: string[] = []
  parts.push(`${n(t.downloads)} download${t.downloads === 1 ? '' : 's'}${prev ? ` (${n(prev.downloads)} the ${period} before)` : ''}`)
  if (t.updates) parts.push(`${n(t.updates)} updates`)
  if (t.iap) parts.push(`${n(t.iap)} in-app purchases`)
  parts.push(`earned ${cash(t.proceeds)} from sales`)
  if (t.adRevenue || t.adImpressions) parts.push(`${cash(t.adRevenue)} from ads (${n(t.adImpressions)} ad impressions)`)
  if (t.impressions !== null) parts.push(`${n(t.impressions)} App Store impressions`)
  if (t.pageViews !== null) parts.push(`${n(t.pageViews)} product page views`)
  if (t.sessions !== null) parts.push(`${n(t.sessions)} sessions`)
  if (t.crashes) parts.push(`${n(t.crashes)} crashes`)
  return `${name}: ${parts.join(', ')}.`
}

/** Text for the model, or null when the tool is not ours. */
export function runAppStoreTool(name: string, args: Record<string, unknown>): string | null {
  if (name !== 'app_store_stats') return null
  if (!appStoreConfigured() && !adsConfigured()) {
    return 'App Store Connect is not set up yet. The key goes in Settings → App Store on the dashboard; until then there are no figures.'
  }
  const wanted = typeof args['app'] === 'string' ? args['app'].trim().toLowerCase() : ''
  const period: Period = args['period'] === 'yesterday' || args['period'] === 'month' ? args['period'] : 'week'
  const to = latestDay()
  const report = buildReport({ from: addDays(to, period === 'yesterday' ? 0 : period === 'week' ? -6 : -29), to })
  let apps = report.byApp
  if (wanted) {
    const match = apps.filter(a => a.name.toLowerCase().includes(wanted) || wanted.includes(a.name.toLowerCase()))
    if (match.length === 0) {
      return `No app called "${args['app']}" — the apps are ${apps.map(a => a.name).join(', ') || 'none yet'}.`
    }
    apps = match
  }
  if (apps.length === 0) return 'There are no apps to report on yet — the first read may still be running, or every app is hidden from the list.'
  const lines = apps.map(a => describe(a.name, a.totals, period === 'yesterday' ? null : a.prev, period, report.currency))
  if (!wanted && apps.length > 1) lines.push(describe('All together', report.totals, period === 'yesterday' ? null : report.prev, period, report.currency))
  const lag = report.coverage.analytics === null && appStoreConfigured()
    ? ' Impressions and page views start arriving a day or two after the key is set up.'
    : ''
  const approx = report.approx ? ` Money is converted to ${report.currency} at today's rate, so it is approximate.` : ''
  return `App figures ${periodWords(period)}, up to ${to} (Apple publishes a day late):\n${lines.join('\n')}${lag}${approx}`
}
