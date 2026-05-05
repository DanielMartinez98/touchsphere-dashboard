// Plays the bundled startup chime (`/start.mp3`) — used both for the
// first-tap orb activation and as the audio "test sound" in settings.

const SOUND_URL = '/start.mp3'

let cachedAudio: HTMLAudioElement | null = null

function getAudio(): HTMLAudioElement {
  if (!cachedAudio) {
    cachedAudio = new Audio(SOUND_URL)
    cachedAudio.preload = 'auto'
  }
  return cachedAudio
}

export async function playStartupSound(): Promise<void> {
  const a = getAudio()
  try {
    a.currentTime = 0
    await a.play()
  } catch {
    /* ignore — autoplay blocked or asset missing */
  }
}
