import { Router, Request, Response } from 'express'
import axios from 'axios'

const router = Router()

// Returns lat/lon for the requesting client's IP via ipapi.co
// This is called by the browser as a fallback when navigator.geolocation
// is unavailable (e.g. over plain HTTP).
router.get('/', async (req: Request, res: Response) => {
  try {
    // Trust the real client IP (X-Forwarded-For if behind a proxy, else req.ip)
    const forwarded = req.headers['x-forwarded-for']
    const clientIp =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      req.ip ??
      ''

    // ipapi.co returns location for the given IP; blank/loopback → auto-detects
    const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === ''
    const url = isLoopback
      ? 'https://ipapi.co/json/'
      : `https://ipapi.co/${encodeURIComponent(clientIp)}/json/`

    const { data } = await axios.get(url, { timeout: 8000 })

    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
      res.status(502).json({ error: 'Geolocation lookup failed' })
      return
    }

    res.json({ lat: data.latitude, lon: data.longitude })
  } catch (err) {
    console.error('GeoIP error:', err)
    res.status(502).json({ error: 'Geolocation lookup failed' })
  }
})

export default router
