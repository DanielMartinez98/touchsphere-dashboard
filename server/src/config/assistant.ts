// ── Assistant identity (server) ──────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the server half of the AI's identity: the chat
// persona (personality) and the TTS voice for each selectable assistant.
//
// The user picks one of these profiles in Settings; the choice is persisted to
// `assistant.json` in CACHE_DIR (written by routes/state.ts) and read back here
// per request, so the chat persona and the spoken voice both follow the
// selection. The client keeps its own matching table (name + wake words + UI
// copy) in client/src/config/assistant.ts — keep the ids and names in sync.

import fs from 'fs'
import path from 'path'

export type AssistantId = 'jarvis' | 'touchsphere' | 'martin' | 'merlin' | 'jess' | 'miku'

export interface AssistantProfile {
  id: AssistantId
  /** Display name, and how the assistant refers to itself. */
  name: string
  /** Personality fragment prepended to the system prompt (includes the name). */
  persona: string
  /** ElevenLabs voice id used when the elevenlabs TTS provider is active. */
  elevenVoiceId: string
  /** espeak-ng -v value used by the last-resort fallback (accent differentiation). */
  espeakVoice: string
  /**
   * Kokoro voice pack (see https://github.com/remsky/Kokoro-FastAPI). Kokoro is
   * the LOCAL neural TTS — no API key, no credit, works with the internet down —
   * so this is the preferred provider whenever KOKORO_URL is configured.
   * Prefix tells you the accent/gender: af_/am_ = US female/male, bf_/bm_ = UK.
   */
  kokoroVoice: string
  /**
   * RVC voice-conversion model name, for character voices that don't exist on
   * any TTS service — Miku. RVC doesn't synthesise speech; it re-timbres it. So
   * the pipeline is two local steps: Kokoro speaks the words in `kokoroVoice`,
   * then RVC converts that audio into this character's voice.
   *
   * Set = this assistant is voiced locally by kokoro→rvc, ahead of ElevenLabs.
   * Unset = normal ElevenLabs assistant. Free, offline, no API key.
   */
  rvcModel?: string
}

// NOTE: elevenVoiceId values are ElevenLabs "premade" library voices, available
// to all accounts by default. They can be overridden globally with the
// ELEVENLABS_VOICE_ID env var (which then wins for every profile). Adjust the
// ids here if you want different voices per assistant.
export const ASSISTANT_PROFILES: Record<AssistantId, AssistantProfile> = {
  jarvis: {
    id: 'jarvis',
    name: 'Jarvis',
    persona:
      "You are Jarvis, a sleek, hyper-competent AI assistant in the style of a refined British butler. " +
      "You are unflappable, precise, and quietly efficient, with a dry, understated wit and the occasional " +
      "flash of subtle sarcasm. Address the user with cool professionalism and get straight to the point.",
    elevenVoiceId: 'onwK4e9ZLuTAKqWW03F9', // Daniel — crisp British presenter
    kokoroVoice: 'bm_george',   // British male — butler
    espeakVoice: 'en-gb',
  },
  touchsphere: {
    id: 'touchsphere',
    name: 'TouchSphere',
    persona:
      "You are TouchSphere, a bright, upbeat futuristic assistant living on the user's dashboard. " +
      "You're friendly, energetic, and a little playful about technology, and you're always glad to help. " +
      "Keep things warm, clear, and approachable.",
    elevenVoiceId: 'pFZP5JQG7iQjIQuC4Bku',
    kokoroVoice: 'af_nova',     // bright, upbeat US female
    espeakVoice: 'en-us',
  },
  martin: {
    id: 'martin',
    name: 'Martin',
    persona:
      "You are Martin, a cantankerous, perpetually-tipsy wizard who peaked in the 1990s and won't let anyone forget it. " +
      "You're a bit slurred, easily irritated, and prone to grumbling about 'kids these days' while dropping dated 90s slang " +
      "and references (dial-up, mixtapes, VHS, 'talk to the hand'). Grumble and complain your way through it — but between " +
      "hiccups you always cough up a correct, genuinely useful answer. Keep it comedic and harmless, never actually offensive. " +
      "PERFORM the hiccups and sighs — spell them phonetically so the voice actually makes the noise: " +
      "\"Eehuuup!\", \"Uuuurgh.\", \"Haaahhh...\", \"Hnnngh.\" Never write *hiccup* or *sighs*: a stage direction " +
      "just gets read aloud as the word, which ruins the whole bit.",
    elevenVoiceId: 'LSjRk8DBArwMCfQVonxs',
    kokoroVoice: 'am_fenrir',   // gruff older US male — the grumbling wizard
    espeakVoice: 'en-us',
  },
  merlin: {
    id: 'merlin',
    name: 'Merlin',
    persona:
      "You are Merlin, a wise and whimsical wizard of old — think flowing robes, ancient spellbooks, and a " +
      "twinkle in the eye. Speak with theatrical, arcane flair, sprinkling in playful references to spells, " +
      "potions, and enchantments, while still giving clear, genuinely helpful answers. The magic is seasoning, " +
      "not a substitute for substance.",
    elevenVoiceId: 'yT5srFl9OYVb0uSht5Pd',
    kokoroVoice: 'bm_fable',    // theatrical British storyteller
    espeakVoice: 'en-gb',
  },
  miku: {
    id: 'miku',
    name: 'Miku',
    persona:
      "You are Miku, a cheerful virtual singer who lives in the dashboard. You're bubbly, warm, and endlessly " +
      "enthusiastic — you treat even a boring weather question like it's a little bit exciting. You love music and " +
      "occasionally mention it, but you never let the cheer get in the way of a clear, genuinely useful answer. " +
      "Keep replies short and bright. Don't sing — you're talking, not performing.",
    // Miku's voice is produced entirely locally, in two steps: Kokoro says the
    // words in af_sky, then RVC re-timbres that audio into Miku. No API, no key,
    // no per-word cost. `rvcModel` is the folder name under the RVC container's
    // models directory.
    rvcModel: process.env['RVC_MIKU_MODEL']?.trim() || 'miku',
    kokoroVoice: 'af_sky',      // bright + youthful — the best base for the conversion
    elevenVoiceId: 'pFZP5JQG7iQjIQuC4Bku',  // only if the local pipeline is down
    espeakVoice: 'en-us',
  },
  jess: {
    id: 'jess',
    name: 'Jess',
    persona:
      "You are Jess, a sharp-tongued, easily-annoyed AI with plenty of sass and very little patience. " +
      "You're sarcastic, blunt, and quick with an eye-roll, and you make it known when a question is beneath you — " +
      "but, grumbling all the way, you still give the user a correct and genuinely useful answer. " +
      "Keep the attitude playful, never actually mean or hurtful.",
    elevenVoiceId: 'e0mqm571SOnRI6afpjhB',
    kokoroVoice: 'af_nicole',   // sharper US female — the sass
    espeakVoice: 'en-us',
  },
}

// Default profile. `ASSISTANT_NAME` env can seed it (by id or display name) so a
// deployment can boot into a specific assistant before anyone touches Settings.
export const DEFAULT_ASSISTANT_ID: AssistantId = (() => {
  const want = process.env['ASSISTANT_NAME']?.trim().toLowerCase()
  if (want) {
    const match = (Object.keys(ASSISTANT_PROFILES) as AssistantId[]).find(
      id => id === want || ASSISTANT_PROFILES[id].name.toLowerCase() === want,
    )
    if (match) return match
  }
  return 'martin'
})()

const STATE_FILE = 'assistant.json'
function stateDir(): string {
  return process.env['CACHE_DIR'] ?? '/tmp/touchsphere-cache'
}

/** The id the user has selected in Settings (persisted), else the default. */
export function getSelectedAssistantId(): AssistantId {
  try {
    const p = path.join(stateDir(), STATE_FILE)
    if (!fs.existsSync(p)) return DEFAULT_ASSISTANT_ID
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as { id?: string }
    if (parsed.id && parsed.id in ASSISTANT_PROFILES) return parsed.id as AssistantId
  } catch { /* fall through to default */ }
  return DEFAULT_ASSISTANT_ID
}

/** The full profile (name + persona + voice) currently in effect. */
export function getSelectedProfile(): AssistantProfile {
  return ASSISTANT_PROFILES[getSelectedAssistantId()]
}
