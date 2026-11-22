# Prompt-fidelity test — 2026-11-22 (lokloComputer, RTX 4090)

Improver: gemma4:26b. Renderers: Qwen-Image 2.1 int8 and MOSS-Image SFT int8, 1024x1024, 25 steps, seed 1000+N.
"new" = rewritten per-model instructions + word limits (Qwen 500 max, MOSS 350 max).
"old" = current instructions + 900-character cap (Qwen only; Daniel stopped the MOSS "old" renders midway).
The score (0-5) is how well the picture matches the REQUEST, not the prompt.

| # | Request | Qwen old | Qwen new | MOSS new |
|---|---|---|---|---|
| 1 | Sakura + Naruto eating ramen at Ichiraku, night | 5 | 5 | 5 |
| 2 | Red fox, blue scarf, stack of books, library, rain on window | 5 | 5 | 5 |
| 3 | Knight vs dragon on castle bridge, knight losing | 2 | 4 | 4 |
| 4 | Black cat vs white cat chess in a park, white winning | 4 | 3 | 3 |
| 5 | Woman, yellow raincoat, sign "OPEN 24 HOURS", diner at night | 5 | 3 | 5 |
| 6 | Goku kicking Vegeta in the face, desert, DBZ | n/s | 5 | 5 |
| | **Total** | 21/25 (5 scored) | **25/30** | **27/30** |

n/s = rendered but not scored (made after the switch to new-only).

## Word counts and NOTE lines ("new")
| | Qwen words | MOSS words | NOTE |
|---|---|---|---|
| 1 | 194 | 125 | empty |
| 2 | 165 | 116 | empty |
| 3 | 212 | 153 | empty |
| 4 | 201 | 153 | empty |
| 5 | 195 | 127 | empty |
| 6 | 233 | 138 | empty |

None of the "new" prompts went over a limit, so none were shortened or cut. The Qwen prompts are 165-233 words (target 150-400), the MOSS prompts 116-153 (target 80-250).
"old" Qwen prompts were 133-139 words. On #3 (1076 chars) and #6 (954 chars) the 900-char cap THREW AWAY the rewrite and drew the raw request (NOTE: "OLD RULE: ... raw request drawn").

## What went wrong, per picture
- qwen-3-old: raw request drawn; the knight is attacking and not losing, and it reads as a pose rather than a fight.
- qwen-3-new: the knight is down and clearly losing, but on a castle rampart rather than a bridge.
- moss-3-new: knight knocked down on a bridge between towers, clearly losing; no sword and a mangled helmet/head.
- qwen-4-old: toppled pieces and the white cat making the move hint at white winning.
- qwen-4-new / moss-4-new: cats, park and chess are right, but nothing shows white winning (on MOSS the board even looks like white is down on pieces).
- qwen-5-new: sign text correct, but an extra, invented second woman holds a duplicate sign in the background.
- All Naruto/DBZ pictures: both named characters are recognisable and in their signature outfits.

## Verdict
- The new instructions fix the worst failure of the old ones: the 900-char cap throwing away good rewrites (#3 knight: 2 -> 4). Word limits are working; no prompt ran over.
- MOSS with the new instructions scored best overall (27/30), including perfect sign text.
- The remaining misses are relational/abstract asks ("who is winning", "knight losing", exact setting "bridge") and one invented extra person on Qwen. The improver should state the winner/loser visually (e.g. "the black cat's side of the board has only a few pieces left, the white cat grins") and repeat "only one woman" for single-subject requests.
- Run note: gemma4:26b and Qwen-Image don't both fit in the 4090's 24 GB. Run improver and renderer one after the other (the test needed a two-phase wrapper, run2.py), or the first render times out and the next improver call returns HTTP 500.
