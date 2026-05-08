import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

function notionHeaders() {
  return {
    Authorization: `Bearer ${process.env['NOTION_API_KEY']}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  }
}

// Find a property by name (case-insensitive) and type from a page's properties map
function findProp(
  props: Record<string, any>,
  names: string[],
  types: string[],
): [string, any] | null {
  for (const name of names) {
    const key = Object.keys(props).find(
      k => k.toLowerCase() === name.toLowerCase() && types.includes(props[k].type),
    )
    if (key) return [key, props[key]]
  }
  return null
}

const DONE_NAMES = new Set(['done', 'completed', 'complete', 'finished', 'closed'])

// GET /api/notion/tasks
router.get('/tasks', async (_req: Request, res: Response) => {
  const apiKey = process.env['NOTION_API_KEY']
  const dbId   = process.env['NOTION_DATABASE_ID']

  if (!apiKey || !dbId) {
    res.status(503).json({ error: 'Notion not configured — set NOTION_API_KEY and NOTION_DATABASE_ID' })
    return
  }

  try {
    const { data } = await axios.post(
      `${NOTION_API}/databases/${dbId}/query`,
      { page_size: 100 },
      { headers: notionHeaders() },
    )

    const tasks = (data.results as any[]).map(page => {
      const props = page.properties as Record<string, any>

      // Title — find the property with type 'title'
      const titleKey = Object.keys(props).find(k => props[k].type === 'title')
      const title: string = titleKey
        ? (props[titleKey].title?.[0]?.plain_text ?? 'Untitled')
        : 'Untitled'

      // Status — named "Status" / "State", type 'status' or 'select'
      const statusEntry = findProp(props, ['status', 'state'], ['status', 'select'])
      const statusProp  = statusEntry?.[1]
      const statusKey   = statusEntry?.[0] ?? 'Status'
      const statusType: 'status' | 'select' | null =
        statusProp?.type === 'status' ? 'status' :
        statusProp?.type === 'select' ? 'select' : null
      const statusName: string | null =
        statusProp?.type === 'status' ? (statusProp.status?.name  ?? null) :
        statusProp?.type === 'select' ? (statusProp.select?.name  ?? null) : null

      // Checkbox fallback (e.g. a "Done" checkbox property)
      const checkEntry  = findProp(props, ['done', 'complete', 'completed', 'finished'], ['checkbox'])
      const doneViaBox  = checkEntry ? (checkEntry[1].checkbox ?? false) : false

      const done = doneViaBox || (statusName != null && DONE_NAMES.has(statusName.toLowerCase()))

      // Priority
      const priorityEntry = findProp(props, ['priority', 'importance'], ['select'])
      const priority: string | null = priorityEntry?.[1]?.select?.name ?? null

      // Due date
      const dueEntry = findProp(props, ['due', 'deadline', 'date'], ['date'])
      const due: string | null = dueEntry?.[1]?.date?.start ?? null

      return { id: page.id, title, status: statusName, statusType, statusKey, priority, due, done }
    })

    console.log(`[notion] fetched ${tasks.length} tasks`)
    res.json(tasks)
  } catch (err: any) {
    console.error('[notion] fetch error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to fetch Notion tasks' })
  }
})

// PATCH /api/notion/tasks/:id  { statusName, statusType, statusKey }
router.patch('/tasks/:id', async (req: Request, res: Response) => {
  if (!process.env['NOTION_API_KEY']) {
    res.status(503).json({ error: 'Notion not configured' })
    return
  }

  const { id } = req.params
  const { statusName, statusType, statusKey } = req.body as {
    statusName?: string
    statusType?: 'status' | 'select'
    statusKey?:  string
  }

  if (!statusName || !statusType || !statusKey) {
    res.status(400).json({ error: 'statusName, statusType, and statusKey are required' })
    return
  }

  const propValue =
    statusType === 'status' ? { status: { name: statusName } }
                            : { select: { name: statusName } }

  try {
    await axios.patch(
      `${NOTION_API}/pages/${id}`,
      { properties: { [statusKey]: propValue } },
      { headers: notionHeaders() },
    )
    console.log(`[notion] marked task ${id} → "${statusName}"`)
    res.json({ ok: true })
  } catch (err: any) {
    console.error('[notion] patch error:', err?.response?.data ?? err.message)
    res.status(502).json({ error: 'Failed to update task' })
  }
})

export default router
