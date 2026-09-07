// A console line that also reaches the server's log.
//
// The kiosk's browser console cannot be read from anywhere — it is an Electron
// window on a Pi with no keyboard — so the voice loop's milestones are sent
// to POST /api/system/client-log as well as printed, and `docker logs` on the
// server shows a spoken turn from both ends. Fire-and-forget: a log line must
// never slow the loop down or fail it.

const API = import.meta.env.VITE_API_URL ?? ''

function role(): string {
  try {
    if (window.innerWidth < 640 || new URLSearchParams(location.search).get('mode') === 'companion') return 'phone'
  } catch { /* ignore */ }
  return 'kiosk'
}

export function clientLog(level: 'info' | 'warn' | 'error', message: string): void {
  const line = `[voice] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
  try {
    void fetch(`${API}/api/system/client-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: role(), level, message }),
      keepalive: true,
    }).catch(() => {})
  } catch { /* ignore */ }
}
