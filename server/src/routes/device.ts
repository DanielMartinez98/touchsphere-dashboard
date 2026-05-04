import { Router, Request, Response } from 'express'
import fs from 'fs'
import os from 'os'

const router = Router()

// ── Helpers for Raspberry Pi / Linux hardware metrics ────────────────────────

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8').trim()
  } catch {
    return null
  }
}

/** CPU temperature in °C.  Pi 5: /sys/class/thermal/thermal_zone0/temp (milli-°C) */
function getCpuTempC(): number | null {
  const raw = readFileSafe('/sys/class/thermal/thermal_zone0/temp')
  if (raw === null) {
    console.warn('[device] /sys/class/thermal/thermal_zone0/temp not available')
    return null
  }
  const milliC = parseInt(raw, 10)
  if (isNaN(milliC)) {
    console.warn(`[device] unexpected thermal value: "${raw}"`)
    return null
  }
  return parseFloat((milliC / 1000).toFixed(1))
}

/** Memory stats from Node's os module (works everywhere). */
function getMemoryStats(): { totalMB: number; availableMB: number; usedPct: number } {
  const totalBytes = os.totalmem()
  const freeBytes  = os.freemem()
  const totalMB    = Math.round(totalBytes / 1024 / 1024)
  const availableMB= Math.round(freeBytes  / 1024 / 1024)
  const usedPct    = parseFloat(((1 - freeBytes / totalBytes) * 100).toFixed(1))
  return { totalMB, availableMB, usedPct }
}

/** System uptime in seconds (Node built-in). */
function getUptimeSeconds(): number {
  return Math.floor(os.uptime())
}

/** CPU load averages (1 min, 5 min, 15 min) — Linux/Pi native. */
function getLoadAverages(): { load1: number; load5: number; load15: number } {
  const [load1, load5, load15] = os.loadavg()
  return {
    load1:  parseFloat(load1.toFixed(2)),
    load5:  parseFloat(load5.toFixed(2)),
    load15: parseFloat(load15.toFixed(2)),
  }
}

/** Number of logical CPUs — used to interpret load averages. */
function getCpuCount(): number {
  return os.cpus().length
}

// ── GET /api/device ───────────────────────────────────────────────────────────
router.get('/', (_req: Request, res: Response) => {
  const start = Date.now()

  const cpuTempC   = getCpuTempC()
  const memory     = getMemoryStats()
  const load       = getLoadAverages()
  const cpuCount   = getCpuCount()
  const uptime     = getUptimeSeconds()
  const platform   = os.platform()
  const arch       = os.arch()
  const hostname   = os.hostname()

  const elapsed = Date.now() - start

  console.log(
    `[device] metrics collected in ${elapsed}ms — ` +
    `temp=${cpuTempC ?? 'n/a'}°C ` +
    `mem=${memory.availableMB}/${memory.totalMB}MB (${memory.usedPct}% used) ` +
    `load=${load.load1}/${load.load5}/${load.load15} ` +
    `uptime=${uptime}s`
  )

  res.json({
    cpuTempC,
    memTotalMB:     memory.totalMB,
    memAvailableMB: memory.availableMB,
    memUsedPct:     memory.usedPct,
    loadAvg1:       load.load1,
    loadAvg5:       load.load5,
    loadAvg15:      load.load15,
    cpuCount,
    uptimeSeconds:  uptime,
    platform,
    arch,
    hostname,
    collectedMs:    elapsed,
  })
})

export default router
