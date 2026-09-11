# Notion corner: "My work" — design

Written 2026-09-11, before the implementation. The Notion corner is the
green pill in work mode. It should answer three questions for one person
who belongs to several teams, each with its own Notion workspace:

1. **What do I have to do next?** — my tasks, across every team, with the
   overdue and the due-today ones on top, and nothing that is someone
   else's mixed in.
2. **What is on the calendars?** — the content calendars (film dates,
   publish dates), meetings and deadlines that live in Notion, on one
   agenda, alongside the Google calendar the Time corner already shows.
3. **How is each team doing?** — per team: what I owe it, what is coming
   up on its boards, what nobody has picked up.

## What is there today, against real data

Three workspaces are connected (Settings → Notion → Workspaces):

| connection | workspace | boards in the task set | "me" set |
|---|---|---|---|
| From .env | Dolce Piquant | Tasks, Meetings, Projects are **hidden**; Docs, Notes not task-like | yes |
| DanGoodGame's | DanGoodGame's | Content Calendar, Todo List | no |
| indy | Productos Indy Social Media | Content Calendar tiktok, Content Calendar Instagram, Todo List | no |

Problems the current Home view has with that data:

- **Everything with a Status is a "task".** The three Content Calendars are
  date-driven content plans (Idea → Drafting → Filming → … → Published,
  with a *Film date* and a *Publish date*) and they land in the same flat
  list as to-dos. The status chip row is the union of ten content statuses
  and three to-do statuses. The default board — where a spoken "add a
  task" goes — is currently *Content Calendar*.
- **Due dates are missed.** `findProp` matches property names exactly, so
  the Todo Lists' *Due date* is not a due date, and content rows have no
  due at all. "Overdue" is therefore wrong for two of the three teams.
- **"Me" is per workspace and unset for two of the three.** Those boards
  show everyone's rows. Notion's user id for a person is in fact the same
  in every workspace they belong to (the same id `280d…1bc6` is the
  Assignee on all three teams' boards, and the value carries the email),
  so one identity can serve all teams.
- **Nothing shows which team a row belongs to** except a board-name chip,
  and there is no per-team view at all.
- **No calendar of Notion dates.** The database view has a month grid, but
  only for one database at a time, and the Time corner's calendar knows
  only Google.
- **Settings order is backwards** for a multi-team setup: identity, the
  thing that decides what "my tasks" means, is at the bottom.

## Concepts

**Team** = a Notion connection (one integration token, one workspace).
Every team gets a **colour** from a fixed palette and a short **name**;
both editable in Settings. The colour is the one visual key that says
"this belongs to indy" on every row, chip, calendar dot and card, so it is
used consistently everywhere and never for anything else.

**Identity ("me")** = one person, stored once: `{ id, name, email }`.
A row is *mine* when any person on its people property matches by id
**or** by email (the email is there whenever the integration can read
user info, which all three can). A per-team override stays possible for
the case where the user is a different account in some workspace; it is
consulted first. A board with no people property cannot express
ownership, so all of its rows count as mine, as today.

Candidates for "who are you" come from each team's member list **and**
from the people seen on its boards' rows — the member list is empty for
the two team workspaces today, but their rows name the user, so the
picker still has the right answer.

**Board role** — each database in the set is one of:

- `tasks` — to-dos. Has a Status (or a done checkbox). Its date is a
  *due* date. These rows are the "My tasks" list and what voice reads.
- `calendar` — date-driven items: content calendars, meetings, editorial
  plans. Their rows are *calendar items*; each dated property becomes an
  entry on the agenda ("🎬 Film · Product launch", "📣 Publish · Product
  launch"). They have a status too, so a row can be done, and a row can be
  mine, but they are never in the task list and never the default board.

The role is detected (rules below) and can be overridden per board in
Settings with a three-way control: Tasks · Calendar · Hidden.

**Item kinds on the agenda**: task due dates (from `tasks` boards),
calendar-board dates (one entry per dated property), and Google events
(read-only, from the existing `/api/calendar/month`). Each is a layer the
user can switch off.

## Screens

### The pill (collapsed)

Unchanged shape, my numbers: **my** pending count, **my** overdue count in
red (or "N today" in amber), and the most urgent of my tasks named. When
identity is unset it shows everyone's, as it does now, and the panel says
so.

### Tabs

`My work · Calendar · Teams · Browse · Search`. Groups move inside Browse
as a third segment (All · Databases · Pages · Groups) — it is a way of
organising pages, which is what Browse is for. On screens narrower than
`sm` the tab labels drop and the icons stay, the rule Widget.tsx already
uses for the pills.

### My work (Home)

Top to bottom:

1. **Header** — "My work", the identity (avatar or initial; tapping it
   opens the inline "who are you" picker), refresh.
2. **Team chips** — All · one chip per team with its colour dot and my
   open count. One tap narrows everything below to that team. Remembered
   per device (localStorage) so the kiosk and the phone can differ.
3. **Focus strip** — four tappable numbers: Overdue · Today · This week ·
   No date. Tapping one filters the list to it; tapping again clears.
   Overdue is red when nonzero. This replaces the status chip row, which
   with several boards was the union of everyone's status names.
4. **My tasks** — grouped: *Overdue*, *Today*, *Next 7 days*, *Later*, *No
   date*; inside a group by priority, then due, then created. Each row:
   the done circle, the title, then chips: team dot + board name (only
   when more than one board is in play), status, priority, due, up to two
   projects. Tap → the task sheet (existing), which gains **Take it** /
   **Hand back** (assign to me / unassign) and shows the team. Done tasks
   stay behind a collapsed "Done · N" header.
5. **Coming up** — the next 7 days as a strip of day cells, each with
   coloured dots for the agenda entries that day (task due, calendar
   items, Google events). Tapping a day opens the Calendar tab on it.
6. **Unassigned** — one line per team that has rows nobody owns on a
   `tasks` board ("3 unassigned on indy"); tapping lists them, and each
   has Take it. Hidden when there are none.
7. The floating + and mic buttons as today. The create sheet's board
   picker is grouped by team and lists only `tasks` boards; the starred
   one is preselected.

With identity unset the list is everyone's and a banner offers the
picker inline. With no `tasks` board at all the list says so and points
at Settings.

### Calendar

Segmented **Month | Agenda**, then a filter row: team chips, "Only mine"
(default on), and layer toggles Tasks · Content · Google.

- **Month**: the grid, each day with up to three dots/bars in team colour
  (Google events in the Time corner's cyan), a count when more. Tapping a
  day lists that day's entries under the grid: kind icon, title, team dot
  and board, status chip, time for Google events. A task entry opens the
  task sheet; a calendar-board entry opens the page (its properties view
  shows status and dates and is editable there); a Google event is
  read-only here.
- **Agenda**: the next 30 days as a scrolling list grouped by day, today
  first, overdue tasks in a red group at the top. Same rows.

Dates are day-granular (Notion dates are; a date with a time shows the
time on the row). Date ranges (a Timeline with start and end) appear on
their start day and are marked "→ Sep 20".

### Teams

One card per team, in connection order, with its colour bar:

- name, workspace, my open count, my overdue count, and a warning line
  when the workspace did not answer;
- **My tasks** here: the top five by the same priority, and "See all →"
  which opens My work filtered to the team;
- **Coming up**: the next five agenda entries from its calendar boards;
- **Unassigned**: count with a "Show" link;
- **Boards**: each board with a role badge and its open count; tap opens
  the database view. Boards Notion would not hand over are marked.
- **Projects** (only where the team has a projects relation, like Dolce
  Piquant's Tasks → Projects): each project with its open count, tap
  filters My work to it.

### Settings → Notion, reordered

1. **Who you are** — one picker, from all teams' members plus the people
   seen on rows, de-duplicated by id/email. Under it, collapsed,
   "A different account in one workspace?" with the per-team overrides.
2. **Teams** — the connections, each with a colour swatch (tap cycles
   the palette) and an editable name; token add/remove as today.
3. **Boards** — every board in effect, grouped by team, each with the
   role control (Tasks · Calendar · Hidden), the default star (enabled
   only for `tasks` boards), and its detected date fields in the
   subtitle ("due: Due date", "film: Film date · publish: Publish date").
4. **Add a board** — as today.
5. **Hidden** — as today, with Show.

## Data and API

### Persisted files (cache volume)

- `notion-connections.json` — gains `prefs: { [connId]: { name?, color? } }`
  so the env connection can be named and coloured too (its token stays in
  `.env`).
- `notion-me.json` — gains `global: { id, name, email }`; `byConn` stays
  as the per-team override. The old top-level `{id,name}` reads as
  `global` now (it used to read as the env connection's), because the
  observation above makes it the right default.
- `notion-task-dbs.json` — gains `roles: { [dbId]: 'tasks' | 'calendar' }`
  for overrides. Hidden stays `excluded`.

### Routes

`GET /api/notion/tasks` stays the one call the corner makes every minute
and the voice tools read; its answer grows and is shared:

```
{
  me:      { id, name, email } | null,          // the identity in effect
  teams:   [{ id, name, workspace, color, ok, error, source }],
  boards:  [{ id, title, icon, conn, role, hasStatus, dueKey, dateKeys:[{key,kind}],
              isDefault, unavailable, openCount, mineCount, unassignedCount }],
  tasks:   NotionTask[] + { mine, unassigned, assignees:[{id,name}], conn },
  items:   CalendarItem[]   // from calendar boards, -30…+90 days
  projects, schemas, merged,                      // as before
}
```

`tasks` now come only from `tasks` boards and are **no longer filtered on
the Notion side** — every row is fetched and `mine` is computed here, so
the screen can show mine first and still reach the rest. The old `me`
field remains for the voice tools' sake; `mes` goes.

A `CalendarItem` is `{ id, title, boardId, conn, status, done, mine,
assignees, dates: [{ key, kind, start, end }], url }`. Calendar boards are
queried with a date-window filter (`or` over their date properties,
on_or_after / on_or_before) so a long content archive does not come down
every minute.

The whole `/tasks` answer is memoised on the server for 20 s and
invalidated by every mutation this app makes, so three screens polling do
not triple the Notion traffic.

New/changed routes:

- `PATCH /api/notion/tasks/:id` accepts `assignee: 'me' | null`.
- `GET /api/notion/me` → `{ me: global, byConn, effective: {connId: me} }`;
  `POST /api/notion/me { id, name, email?, conn? }` — no `conn` sets the
  global identity; `conn` sets an override; `id: null` clears either.
- `GET /api/notion/users` → also returns `seen` (people from rows) per
  connection, so the picker works when the member list is empty.
- `PATCH /api/notion/connections/:id { name?, color? }` — works for the env
  connection now.
- `POST /api/notion/task-dbs/role { id, role }`.
- `GET /api/notion/task-dbs` rows gain `role`, `dueKey`, `dateKeys`.

Everything that changes the shape of the set (role, colour, name,
identity) broadcasts `notion {kind:'task-dbs'}` as today, and the corner
refetches.

### Detection rules

Date property kinds, by name (case-insensitive, contains):

| kind | matches |
|---|---|
| due | due, deadline |
| publish | publish, post date, release, go live, air |
| film | film, shoot, record |
| date | anything else of type date (event, when, meeting, timeline, date…) |

Board role, in order:

1. the override in `roles`, if any;
2. `calendar` if it has a `publish` or `film` date, or its title contains
   calendar / schedule / meeting / editorial / content / events;
3. `tasks` if it has a Status or a done checkbox;
4. `calendar` if it has any date property (Projects with its Timeline);
5. otherwise it is listed under Browse only and not a board.

For a `tasks` board, `dueKey` is its `due` date, else its only date
property, else none. Only `tasks` boards can be the default; the
effective default is the starred one if it is a `tasks` board with a
Status, else the first such board.

### "Mine"

`mine(row)` = the row's people values (every people-type property, not
only the detected assignee one) contain the identity's id or email, where
identity = `byConn[conn] ?? global`. `unassigned` = the board has a people
property and the row has nobody. A board with no people property: every
row `mine`, none `unassigned`.

## Refresh, cost, failure

- Same cadence: every minute while the corner exists, on panel open, on
  tab visibility, on every `notion` SSE frame. Google events for the
  Calendar tab come from `/api/calendar/month`, cached on the server for
  15 minutes already.
- Per refresh: one query per board (eight today) plus cached schemas and
  project titles; well inside Notion's three requests a second average,
  and shared across devices by the 20 s memo.
- One team failing (revoked token, Notion down for it) marks that team
  `ok:false` with the reason on its chip and card; the other teams' data
  is unaffected. The pill keeps the last good list and says it is stale,
  as today.
- No identity: everyone's rows, a banner with the inline picker; no
  `tasks` boards: an explanation and a pointer to Settings; no calendar
  boards and no Google calendar: the Calendar tab shows task due dates
  only.

## Voice

`list_tasks`, `complete_task`, `set_task_due` read `/tasks` and now see
only `tasks` boards and default to **my** tasks (`which: 'everyone'`
widens). `add_notion_task` is unchanged and lands in the default `tasks`
board, assigned to me.

## Files

Server: `routes/notion.ts` (schema detection, roles, identity, the
enriched `/tasks`, items, memo, new routes), `notion-connections.ts`
(prefs), `routes/dashboard-tools.ts` (mine by default).

Client: `hooks/useNotion.ts` (new shape), `hooks/useTaskDbs.ts` (roles),
`hooks/useNotionMe.ts` (server identity, seen people), NotionWidget:
`NotionExpanded.tsx` (tabs), `MyWorkView.tsx` (replaces HomeView),
`AgendaView.tsx`, `TeamsView.tsx`, `TaskSheet.tsx` / `CreateTaskSheet.tsx`
/ `TaskRow.tsx` / `task-utils.ts` (pulled out of HomeView), `BrowseView.tsx`
(Groups segment), `NotionWidget.tsx` (pill), `notion-types.ts` (NavView),
`SettingsPanel.tsx` (the Notion tab). `CLAUDE.md` and `.env.example`.

## Out of scope

Editing Google events from the Notion corner (the Time corner does that),
Notion's own calendar product, notifications, and anything that needs the
2025 data-source API version.
