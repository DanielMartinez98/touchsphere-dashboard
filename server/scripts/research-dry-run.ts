// What the guide generator WOULD read, without writing a guide.
//
//   npm run research -- "The Legend of Zelda: Majora's Mask"
//   npm run research -- "Hollow Knight" "Bosses" "Charms"
//
// Why this exists: the research half of a guide is a dozen searches and page
// reads whose only visible output used to be the finished document, minutes and
// a dozen model calls later. When a chapter came out wrong the question — which
// page did that come from? — was unanswerable without regenerating the whole
// thing. Every failure that made the guides unusable was a RESEARCH failure
// (a franchise wiki answering for the wrong game, an encyclopedia article where
// a walkthrough was wanted), so this prints exactly that layer and stops.
//
// No model is called and nothing is written to disk.

import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

/* eslint-disable import/first */
import {
  communityChapters,
  communityTableOfContents,
  findGameWiki,
  gameQualifier,
  mentionsGame,
  researchGame,
  SEARCH_PROVIDER,
  titleKeywords,
} from '../src/research'

const WEB_FIRST = SEARCH_PROVIDER === 'ollama'

function heading(s: string): void {
  console.log(`\n\x1b[1m── ${s} ${'─'.repeat(Math.max(0, 66 - s.length))}\x1b[0m`)
}

async function main(): Promise<void> {
  const [title, ...sections] = process.argv.slice(2)
  if (!title) {
    console.error('usage: npm run research -- "<game title>" [section title…]')
    process.exit(1)
  }

  heading('Identity')
  console.log(`title       : ${title}`)
  console.log(`qualifier   : ${gameQualifier(title)}   (what searches are scoped by)`)
  console.log(`keywords    : ${titleKeywords(title).join(', ') || '(none — this title cannot be filtered on)'}`)
  console.log(`search      : ${SEARCH_PROVIDER}${WEB_FIRST ? ' — walkthrough sites first' : ' — wiki first'}`)

  heading('Wiki')
  const wiki = await findGameWiki(title)
  if (!wiki) {
    console.log('no wiki found — Wikipedia and the open web will carry the whole guide')
  } else {
    console.log(`host        : ${wiki.host}`)
    console.log(`shared      : ${wiki.shared}` +
      (wiki.shared
        ? '   ← franchise wiki: queries get scoped and every page is containment-checked'
        : '   ← this game only'))
  }

  heading('Chapter list (from the wiki\'s own per-game categories)')
  const chapters = await communityChapters(title)
  if (chapters.length === 0) console.log('(none — the outline will lean on article headings instead)')
  for (const c of chapters) console.log(`${c.label} (${c.members.length}):\n  ${c.members.join(', ')}`)

  heading('Article headings, after dropping encyclopedia furniture')
  const toc = await communityTableOfContents(title)
  console.log(toc.length > 0 ? toc.map(t => `- ${t}`).join('\n') : '(none survived)')

  // The sections the generator would research: whatever was asked for on the
  // command line, else the outline's own two passes.
  const topics = sections.length > 0 ? sections : ['', 'walkthrough 100% completion']
  for (const topic of topics) {
    heading(`Research: ${topic === '' ? '(the game itself)' : topic}`)
    const pages = await researchGame(title, topic, {
      limit: 2,
      maxChars: 14000,
      webFirst: WEB_FIRST && topic !== '',
      requireGameMention: true,
    })
    if (pages.length === 0) {
      console.log('\x1b[31mNOTHING — this chapter would be written from the guide-wide fallback\x1b[0m')
      continue
    }
    for (const p of pages) {
      const ok = mentionsGame(`${p.title}\n${p.text}`, title)
      console.log(
        `${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ WRONG GAME\x1b[0m'} ` +
        `${p.site}  "${p.title.slice(0, 60)}"  ${p.text.length.toLocaleString()} chars`,
      )
      console.log(`    ${p.url}`)
      console.log(`    ${p.text.slice(0, 220).replace(/\s+/g, ' ')}…`)
    }
  }
  console.log()
}

main().catch(err => { console.error(err); process.exit(1) })
