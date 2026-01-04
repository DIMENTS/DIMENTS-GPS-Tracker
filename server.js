// server.js — DIMENTS GPS Tracker (Jetson-proof editie)
// - Endpoints + bestandsnamen blijven gelijk
// - Route logging: NDJSON (stream/append) om RAM-issues te voorkomen
// - Public GeoJSON rebuild: gedebounced/throttled (scheelt CPU/IO)
// - HTTPS cert loader: robuuster (certbot + win-acme filenames)

require("dotenv").config()
const express = require("express")
const fs = require("fs")
const path = require("path")
const cors = require("cors")
const axios = require("axios")
const https = require("https")
const http = require("http")
const readline = require("readline")
const { v4: uuid } = require("uuid")

const app = express()
const PORT = Number(process.env.PORT || 3000)
const DOMAIN = process.env.DOMAIN || "irllogging.duckdns.org"

app.use(cors())
app.use(express.json({ limit: "2mb" }))
app.use(express.urlencoded({ extended: false }))

// ─────────────────────────────────────────────
// Process-level safety net (voorkomt “random” exits)
// ─────────────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("❌ UNHANDLED REJECTION:", reason)
})

process.on("uncaughtException", (err) => {
  console.error("❌ UNCAUGHT EXCEPTION:", err)
})

process.on("SIGINT", () => {
  console.log("🛑 SIGINT ontvangen, server stopt…")
  process.exit(0)
})
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM ontvangen, server stopt…")
  process.exit(0)
})

// ─────────────────────────────────────────────
// HTTP client: keep-alive voor stabielere API calls
// ─────────────────────────────────────────────
const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

const axiosClient = axios.create({
  timeout: 8000,
  httpAgent,
  httpsAgent,
})

// ─────────────────────────────────────────────
// Weather fetch throttling / dedupe / log rate limit
// ─────────────────────────────────────────────
const WEATHER_MIN_INTERVAL_MS = Number(process.env.WEATHER_MIN_INTERVAL_MS || 60_000) // 60s default
let weatherInFlight = null
let lastWeatherFetchAt = 0
let lastWeatherLogAt = 0

function shouldLogWeatherError() {
  const now = Date.now()
  // log max 1x per 30s om spam te voorkomen
  if (now - lastWeatherLogAt > 30_000) {
    lastWeatherLogAt = now
    return true
  }
  return false
}

// ─────────────────────────────────────────────
// HTTPS configuratie (certbot + win-acme support)
// ─────────────────────────────────────────────
// Op Jetson (JetPack 4.x) is dit meestal:
// CERT_PATH=/etc/letsencrypt/live/<domain>
const CERT_PATH = process.env.CERT_PATH || path.join(__dirname, "certs")

function firstExistingFile(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p
  }
  return null
}

function loadHttpsOptions() {
  // Key candidates
  const keyFile = firstExistingFile([
    path.join(CERT_PATH, "privkey.pem"),
    path.join(CERT_PATH, `${DOMAIN}-key.pem`),
    path.join(CERT_PATH, "key.pem"),
  ])

  // Cert candidates (leaf+chain liefst)
  const fullchainFile = firstExistingFile([
    path.join(CERT_PATH, "fullchain.pem"),
    path.join(CERT_PATH, `${DOMAIN}-fullchain.pem`),
  ])

  // win-acme varianten (uit jouw screenshot)
  const crtFile = firstExistingFile([
    path.join(CERT_PATH, `${DOMAIN}-crt.pem`),
    path.join(CERT_PATH, "cert.pem"),
  ])
  const chainFile = firstExistingFile([
    path.join(CERT_PATH, `${DOMAIN}-chain.pem`),
    path.join(CERT_PATH, `${DOMAIN}-chain-only.pem`),
    path.join(CERT_PATH, "chain.pem"),
  ])

  if (!keyFile) {
    throw new Error("SSL key niet gevonden (privkey.pem / <domain>-key.pem / key.pem).")
  }

  // Prefer fullchain (certbot)
  if (fullchainFile) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(fullchainFile) }
  }

  // Fallback: crt + chain samenvoegen (win-acme)
  if (crtFile && chainFile) {
    const cert = Buffer.concat([fs.readFileSync(crtFile), Buffer.from("\n"), fs.readFileSync(chainFile)])
    return { key: fs.readFileSync(keyFile), cert }
  }

  // Fallback: alleen crt (niet ideaal, maar beter dan niks)
  if (crtFile) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(crtFile) }
  }

  // Fallback: alleen chain (meestal niet genoeg)
  if (chainFile) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(chainFile) }
  }

  throw new Error("SSL certificaten niet gevonden (fullchain.pem of <domain>-crt.pem + <domain>-chain.pem).")
}

// ─────────────────────────────────────────────
// Static
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")))

// ─────────────────────────────────────────────
// Data-bestanden (optioneel naar SSD via DATA_DIR)
// ─────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "data")

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

const files = {
  route: path.join(DATA_DIR, "routeData.json"), // blijft dezelfde naam (maar kan NDJSON zijn)
  routePublic: path.join(DATA_DIR, "route_public.geojson"),
  pois: path.join(DATA_DIR, "pois.json"),
  location: path.join(DATA_DIR, "locationData.json"),
  altitude: path.join(DATA_DIR, "altitudeData.json"),
  temperature: path.join(DATA_DIR, "temperatureData.json"),
  privacyZones: path.join(DATA_DIR, "privacyZones.json"),
  routesets: path.join(DATA_DIR, "routesets.json"),
  rides: path.join(DATA_DIR, "rides.json"),
  buttonStates: path.join(DATA_DIR, "buttonStates.json"),
  routesetFile: (id) => path.join(DATA_DIR, `routeset_${id}.json`),
}

function ensureFile(p, def) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def, null, 2), "utf-8")
}

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"))
  } catch {
    return null
  }
}

/**
 * JSON writer:
 * - schrijft eerst naar .tmp
 * - probeert atomic rename
 * - bij rename-fail: fallback copy+replace
 */
function writeJSON(p, obj) {
  const tmp = p + ".tmp"
  const payload = JSON.stringify(obj, null, 2)
  fs.writeFileSync(tmp, payload, "utf-8")

  const MAX_RETRIES = 5
  let lastErr = null

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      fs.renameSync(tmp, p)
      return
    } catch (e) {
      lastErr = e
      const start = Date.now()
      while (Date.now() - start < 20 * (i + 1)) {}
    }
  }

  try {
    fs.copyFileSync(tmp, p)
    fs.unlinkSync(tmp)
    return
  } catch (e) {
    console.error("❌ writeJSON fallback failed:", e)
    throw lastErr || e
  }
}

// Init defaults (route wordt hieronder apart geregeld)
ensureFile(files.pois, [])
ensureFile(files.location, {})
ensureFile(files.altitude, {})
ensureFile(files.temperature, {})
ensureFile(files.privacyZones, [])
ensureFile(files.routesets, [])
ensureFile(files.rides, [])
ensureFile(files.buttonStates, { pause: false, privacy: false })
ensureFile(files.routePublic, { type: "FeatureCollection", features: [] })

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function haversineKm(a, b) {
  return distanceMeters(a.lat, a.lon, b.lat, b.lon) / 1000
}

// ─────────────────────────────────────────────
// Privacy zones caching (scheelt disk IO)
// ─────────────────────────────────────────────
const PRIVACY_CACHE_TTL_MS = Number(process.env.PRIVACY_CACHE_TTL_MS || 10_000)
let privacyCache = { zones: [], loadedAt: 0 }

function getPrivacyZones() {
  const now = Date.now()
  if (now - privacyCache.loadedAt < PRIVACY_CACHE_TTL_MS) return privacyCache.zones
  const zones = readJSON(files.privacyZones) || []
  privacyCache = { zones, loadedAt: now }
  return zones
}

function inPrivacyZone(lat, lon) {
  const zones = getPrivacyZones()
  return zones.some((z) => distanceMeters(lat, lon, z.lat, z.lon) <= z.radius)
}

// ─────────────────────────────────────────────
// Route storage (auto/json/ndjson) — bestandsnaam blijft routeData.json
// ─────────────────────────────────────────────
const ROUTE_STORAGE = (process.env.ROUTE_STORAGE || "auto").toLowerCase() // auto|json|ndjson
let routeFormat = "ndjson" // wordt gedetecteerd/gezet in init
let lastRoutePoint = null // alleen voor filteren; niet kritisch als null

function detectRouteFormat(p) {
  if (ROUTE_STORAGE === "json") return "json"
  if (ROUTE_STORAGE === "ndjson") return "ndjson"

  // auto: kijk naar eerste non-whitespace char
  try {
    if (!fs.existsSync(p)) return "ndjson"
    const fd = fs.openSync(p, "r")
    const buf = Buffer.alloc(2048)
    const n = fs.readSync(fd, buf, 0, buf.length, 0)
    fs.closeSync(fd)
    const s = buf.slice(0, n).toString("utf-8")
    const m = s.match(/[^\s]/)
    if (!m) return "ndjson" // leeg
    const ch = m[0]
    return ch === "[" ? "json" : "ndjson"
  } catch {
    return "ndjson"
  }
}

function ensureRouteFile() {
  if (fs.existsSync(files.route)) return
  // Nieuwe install: NDJSON by default (Jetson-proof)
  fs.writeFileSync(files.route, "", "utf-8")
}

function safeParseJSONLine(line) {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function readLastNonEmptyLine(filePath, maxBytes = 128 * 1024) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.size) return null
    const size = stat.size
    const readSize = Math.min(maxBytes, size)
    const fd = fs.openSync(filePath, "r")
    const buf = Buffer.alloc(readSize)
    fs.readSync(fd, buf, 0, readSize, size - readSize)
    fs.closeSync(fd)
    const chunk = buf.toString("utf-8")
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim().length)
    if (!lines.length) return null
    return lines[lines.length - 1]
  } catch {
    return null
  }
}

function initRouteState() {
  ensureRouteFile()
  routeFormat = detectRouteFormat(files.route)

  if (routeFormat === "ndjson") {
    const lastLine = readLastNonEmptyLine(files.route)
    const last = lastLine ? safeParseJSONLine(lastLine) : null
    if (last && typeof last.lat === "number" && typeof last.lon === "number") {
      lastRoutePoint = last
    }
  } else {
    // legacy JSON-array — alleen proberen voor “last point”
    const arr = readJSON(files.route)
    if (Array.isArray(arr) && arr.length) lastRoutePoint = arr[arr.length - 1]
  }

  console.log(`🧭 routeData.json storage: ${routeFormat.toUpperCase()} (ROUTE_STORAGE=${ROUTE_STORAGE})`)
}

async function streamRoutePointsNdjson({ redact = false, onPoint }) {
  if (!fs.existsSync(files.route)) return
  const rs = fs.createReadStream(files.route, { encoding: "utf-8" })
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
  for await (const line of rl) {
    const l = line.trim()
    if (!l) continue
    const p = safeParseJSONLine(l)
    if (!p) continue
    if (typeof p.lat !== "number" || typeof p.lon !== "number") continue
    if (redact && inPrivacyZone(p.lat, p.lon)) continue
    await onPoint(p)
  }
}

function appendRoutePointNdjson(point) {
  fs.appendFileSync(files.route, JSON.stringify(point) + "\n", "utf-8")
}

async function streamRouteAsJsonArray(res, { redact = false } = {}) {
  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache")
  res.write("[")
  let first = true

  if (routeFormat === "ndjson") {
    await streamRoutePointsNdjson({
      redact,
      onPoint: async (p) => {
        if (!first) res.write(",")
        first = false
        res.write(JSON.stringify(p))
      },
    })
  } else {
    const arr = readJSON(files.route) || []
    for (const p of arr) {
      if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") continue
      if (redact && inPrivacyZone(p.lat, p.lon)) continue
      if (!first) res.write(",")
      first = false
      res.write(JSON.stringify(p))
    }
  }

  res.end("]")
}

async function streamRouteAsGeoJSON(res, { redact = true } = {}) {
  res.setHeader("Content-Type", "application/geo+json; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache")

  // We schrijven pas een feature als we zeker 2 coords hebben.
  res.write('{"type":"FeatureCollection","features":[')

  let startedFeature = false
  let buffered = [] // max 2 coords strings
  let firstCoordWritten = false

  const startFeature = () => {
    res.write(
      '{"type":"Feature","properties":{"source":"routeData.json","redact":' +
        (redact ? "true" : "false") +
        '},"geometry":{"type":"LineString","coordinates":['
    )
    // flush buffered coords
    res.write(buffered[0])
    res.write(",")
    res.write(buffered[1])
    firstCoordWritten = true
    startedFeature = true
  }

  const writeCoord = (coordStr) => {
    if (!startedFeature) {
      buffered.push(coordStr)
      if (buffered.length === 2) startFeature()
      return
    }
    // feature al gestart
    res.write(",")
    res.write(coordStr)
  }

  const onPoint = async (p) => {
    const coordStr = `[${+p.lon},${+p.lat}]`
    writeCoord(coordStr)
  }

  if (routeFormat === "ndjson") {
    await streamRoutePointsNdjson({ redact, onPoint })
  } else {
    const arr = readJSON(files.route) || []
    for (const p of arr) {
      if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") continue
      if (redact && inPrivacyZone(p.lat, p.lon)) continue
      await onPoint(p)
    }
  }

  if (!startedFeature) {
    // < 2 coords
    return res.end("]}")
  }

  // sluit feature + fc
  res.end("]}}]}")
}

// ─────────────────────────────────────────────
// Public GeoJSON file: debounced rebuild (scheelt IO bij grote routes)
// ─────────────────────────────────────────────
const PUBLIC_GEOJSON_MIN_INTERVAL_MS = Number(process.env.PUBLIC_GEOJSON_MIN_INTERVAL_MS || 30_000)
let lastPublicGeojsonAt = 0
let publicGeojsonTimer = null

async function rebuildPublicRouteGeoJSON() {
  const tmp = files.routePublic + ".tmp"

  // schrijf header
  const ws = fs.createWriteStream(tmp, { encoding: "utf-8" })
  ws.write('{"type":"FeatureCollection","features":[')

  let startedFeature = false
  let buffered = [] // 2 coords strings

  const startFeature = () => {
    ws.write(
      '{"type":"Feature","properties":{"source":"routeData.json","redact":true},"geometry":{"type":"LineString","coordinates":['
    )
    ws.write(buffered[0])
    ws.write(",")
    ws.write(buffered[1])
    startedFeature = true
  }

  const writeCoord = (coordStr) => {
    if (!startedFeature) {
      buffered.push(coordStr)
      if (buffered.length === 2) startFeature()
      return
    }
    ws.write(",")
    ws.write(coordStr)
  }

  const onPoint = async (p) => {
    const coordStr = `[${+p.lon},${+p.lat}]`
    writeCoord(coordStr)
  }

  try {
    if (routeFormat === "ndjson") {
      await streamRoutePointsNdjson({ redact: true, onPoint })
    } else {
      const arr = readJSON(files.route) || []
      for (const p of arr) {
        if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") continue
        if (inPrivacyZone(p.lat, p.lon)) continue
        await onPoint(p)
      }
    }
  } catch (e) {
    console.error("❌ rebuildPublicRouteGeoJSON stream failed:", e?.message || e)
  }

  if (!startedFeature) {
    ws.write("]}")
  } else {
    ws.write("]}}]}")
  }

  await new Promise((resolve) => ws.end(resolve))

  try {
    fs.renameSync(tmp, files.routePublic)
  } catch (e) {
    try {
      fs.copyFileSync(tmp, files.routePublic)
      fs.unlinkSync(tmp)
    } catch (e2) {
      console.error("❌ persistPublicRouteGeoJSON failed:", e2)
    }
  }
}

function schedulePublicRouteRebuild() {
  const now = Date.now()
  const wait = Math.max(0, PUBLIC_GEOJSON_MIN_INTERVAL_MS - (now - lastPublicGeojsonAt))

  if (publicGeojsonTimer) return // al gepland

  publicGeojsonTimer = setTimeout(async () => {
    publicGeojsonTimer = null
    try {
      await rebuildPublicRouteGeoJSON()
      lastPublicGeojsonAt = Date.now()
    } catch (e) {
      console.error("❌ public geojson rebuild failed:", e?.message || e)
    }
  }, wait)
}

// ─────────────────────────────────────────────
// Button state (pauze / privacy)
// ─────────────────────────────────────────────
app.get("/api/buttons", (_req, res) => {
  res.json(readJSON(files.buttonStates) || { pause: false, privacy: false })
})

app.post("/api/buttons", (req, res) => {
  const { pause, privacy } = req.body || {}
  const state = { pause: !!pause, privacy: !!privacy }
  writeJSON(files.buttonStates, state)
  res.json({ ok: true, ...state })
})

// ─────────────────────────────────────────────
// Route ingest / read / reset (endpoints onveranderd)
// ─────────────────────────────────────────────
app.post("/api/route", (req, res) => {
  const arr = Array.isArray(req.body) ? req.body : [req.body]

  const MIN_DIST_M = 15
  const MIN_TIME_MS = 4000
  const MAX_SPEED_KMH = 160

  let added = 0
  let redacted = 0

  if (routeFormat === "json") {
    // Legacy gedrag (kan RAM-heavy zijn). Jetson: migreer naar NDJSON.
    const route = readJSON(files.route) || []

    for (const p of arr) {
      if (typeof p?.lat !== "number" || typeof p?.lon !== "number") continue
      if (inPrivacyZone(p.lat, p.lon)) {
        redacted++
        continue
      }

      const tNow = p.timestamp ? new Date(p.timestamp).getTime() : Date.now()
      const last = route.length ? route[route.length - 1] : null

      if (last) {
        const dist = distanceMeters(last.lat, last.lon, p.lat, p.lon)
        const dt = Math.max(1, tNow - new Date(last.timestamp).getTime())
        const speed = (dist / (dt / 1000)) * 3.6

        if (dist < MIN_DIST_M) continue
        if (dt < MIN_TIME_MS) continue
        if (speed > MAX_SPEED_KMH) continue
      }

      const point = {
        lat: +p.lat,
        lon: +p.lon,
        timestamp: p.timestamp ? new Date(p.timestamp).toISOString() : new Date().toISOString(),
      }

      if (typeof p.alt === "number" && isFinite(p.alt)) point.alt = p.alt
      if (typeof p.heading === "number" && isFinite(p.heading)) point.heading = p.heading
      if (typeof p.speedKmh === "number" && isFinite(p.speedKmh)) point.speedKmh = Math.round(p.speedKmh)

      route.push(point)
      lastRoutePoint = point
      added++
    }

    if (added) writeJSON(files.route, route)
    schedulePublicRouteRebuild()
    return res.json({ ok: true, added, redacted, routeFormat })
  }

  // NDJSON: append-only, geen gigantische JSON.parse meer
  for (const p of arr) {
    if (typeof p?.lat !== "number" || typeof p?.lon !== "number") continue

    if (inPrivacyZone(p.lat, p.lon)) {
      redacted++
      continue
    }

    const tNow = p.timestamp ? new Date(p.timestamp).getTime() : Date.now()
    const last = lastRoutePoint

    if (last && typeof last.lat === "number" && typeof last.lon === "number") {
      const dist = distanceMeters(last.lat, last.lon, p.lat, p.lon)
      const dt = Math.max(1, tNow - new Date(last.timestamp || Date.now()).getTime())
      const speed = (dist / (dt / 1000)) * 3.6

      if (dist < MIN_DIST_M) continue
      if (dt < MIN_TIME_MS) continue
      if (speed > MAX_SPEED_KMH) continue
    }

    const point = {
      lat: +p.lat,
      lon: +p.lon,
      timestamp: p.timestamp ? new Date(p.timestamp).toISOString() : new Date().toISOString(),
    }

    if (typeof p.alt === "number" && isFinite(p.alt)) point.alt = p.alt
    if (typeof p.heading === "number" && isFinite(p.heading)) point.heading = p.heading
    if (typeof p.speedKmh === "number" && isFinite(p.speedKmh)) point.speedKmh = Math.round(p.speedKmh)

    appendRoutePointNdjson(point)
    lastRoutePoint = point
    added++
  }

  if (added) schedulePublicRouteRebuild()
  return res.json({ ok: true, added, redacted, routeFormat })
})

app.get("/api/route", async (_req, res) => {
  try {
    await streamRouteAsJsonArray(res, { redact: false })
  } catch (e) {
    console.error("api/route failed:", e?.message || e)
    res.status(500).json({ error: "route read failed" })
  }
})

app.post("/api/route/reset", (_req, res) => {
  try {
    if (routeFormat === "ndjson") {
      fs.writeFileSync(files.route, "", "utf-8")
      lastRoutePoint = null
    } else {
      writeJSON(files.route, [])
      lastRoutePoint = null
    }
    // meteen rebuilden (klein bestand)
    lastPublicGeojsonAt = 0
    if (publicGeojsonTimer) {
      clearTimeout(publicGeojsonTimer)
      publicGeojsonTimer = null
    }
    void rebuildPublicRouteGeoJSON()
    res.json({ ok: true })
  } catch (e) {
    console.error("route reset failed:", e?.message || e)
    res.status(500).json({ error: "reset failed" })
  }
})

app.get("/api/route.geojson", async (_req, res) => {
  try {
    await streamRouteAsGeoJSON(res, { redact: true })
  } catch (e) {
    console.error("geojson stream failed:", e?.message || e)
    res.status(500).json({ error: "geojson build failed" })
  }
})

app.get("/api/route/public-file", (_req, res) => {
  if (!fs.existsSync(files.routePublic)) {
    return res.status(404).json({ error: "Not found" })
  }
  res.setHeader("Content-Type", "application/geo+json; charset=utf-8")
  res.setHeader("Cache-Control", "no-cache")
  fs.createReadStream(files.routePublic).pipe(res)
})

app.post("/api/route/rebuild-geojson", async (_req, res) => {
  try {
    await rebuildPublicRouteGeoJSON()
    lastPublicGeojsonAt = Date.now()
    res.json({ ok: true })
  } catch (e) {
    console.error("rebuild-geojson failed:", e?.message || e)
    res.status(500).json({ error: "rebuild failed" })
  }
})

app.get("/getRoute", async (req, res) => {
  try {
    const redact = req.query.redact !== "0"
    await streamRouteAsJsonArray(res, { redact })
  } catch (e) {
    console.error("getRoute failed:", e?.message || e)
    res.status(500).json({ error: "getRoute failed" })
  }
})

// ─────────────────────────────────────────────
// Location (met heading & speed)
// ─────────────────────────────────────────────
app.post("/api/location", async (req, res) => {
  try {
    const { lat, lon, alt, heading, speedKmh } = req.body || {}
    if (typeof lat !== "number" || typeof lon !== "number") {
      return res.status(400).json({ error: "lat/lon required" })
    }

    if (inPrivacyZone(lat, lon)) {
      const last = readJSON(files.location) || {}
      return res.json({ ...last, redacted: true })
    }

    const nowIso = new Date().toISOString()
    const locData = {
      lat: +lat,
      lon: +lon,
      city: "",
      countryCode: "",
      timestamp: nowIso,
    }

    if (typeof heading === "number" && isFinite(heading)) {
      locData.heading = heading
    }
    if (typeof speedKmh === "number" && isFinite(speedKmh)) {
      locData.speedKmh = Math.round(speedKmh)
    }

    if (process.env.MAPBOX_TOKEN) {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?types=place,country&access_token=${process.env.MAPBOX_TOKEN}`
      try {
        const { data } = await axiosClient.get(url)
        const feats = data?.features || []
        const place = feats.find((f) => (f.place_type || []).includes("place")) || {}
        const country = feats.find((f) => (f.place_type || []).includes("country")) || {}
        locData.city = place.text || ""
        locData.countryCode = (country.properties?.short_code || "").toUpperCase()
      } catch {
        // stil falen
      }
    }

    writeJSON(files.location, locData)

    if (typeof alt === "number" && isFinite(alt)) {
      writeJSON(files.altitude, { altitude: +alt, timestamp: nowIso })
    }

    res.json({ ...locData, redacted: false })
  } catch (e) {
    console.error("Location error:", e.message)
    res.status(500).json({ error: "location failed" })
  }
})

app.get("/api/location", (_req, res) => {
  res.json(readJSON(files.location) || {})
})

// ─────────────────────────────────────────────
// Altitude & Temperature
// ─────────────────────────────────────────────
app.get("/api/altitude", (_req, res) => {
  res.json(readJSON(files.altitude) || {})
})

app.post("/api/altitude", (req, res) => {
  const { altitude } = req.body || {}
  if (typeof altitude !== "number") {
    return res.status(400).json({ error: "altitude required" })
  }
  writeJSON(files.altitude, {
    altitude: +altitude,
    timestamp: new Date().toISOString(),
  })
  res.json({ ok: true })
})

// ✅ Endpoint blijft exact hetzelfde, maar fetch is “slim”
app.get("/api/temperature", async (_req, res) => {
  const cached = readJSON(files.temperature) || {}
  const loc = readJSON(files.location) || {}
  const { lat, lon } = loc
  const apiKey = process.env.OPENWEATHER_KEY

  // Als we geen inputs hebben: geef cached terug (zoals eerst)
  if (!lat || !lon || !apiKey) return res.json(cached)

  const now = Date.now()

  // 1) Throttle
  if (now - lastWeatherFetchAt < WEATHER_MIN_INTERVAL_MS) return res.json(cached)

  // 2) Dedupe
  if (weatherInFlight) {
    try {
      await weatherInFlight
    } catch {}
    return res.json(readJSON(files.temperature) || cached)
  }

  // 3) Start nieuwe fetch
  weatherInFlight = (async () => {
    try {
      const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=nl`
      const { data } = await axiosClient.get(url)

      const payload = {
        temp: Math.round(data.main?.temp),
        feels_like: Math.round(data.main?.feels_like),
        humidity: data.main?.humidity,
        pressure: data.main?.pressure,
        wind_speed: data.wind?.speed,
        wind_deg: data.wind?.deg,
        weather_main: data.weather?.[0]?.main,
        weather_description: data.weather?.[0]?.description,
        icon: data.weather?.[0]?.icon,
        city: data.name || "",
        timestamp: new Date().toISOString(),
      }

      writeJSON(files.temperature, payload)
      lastWeatherFetchAt = Date.now()
    } catch (e) {
      if (shouldLogWeatherError()) console.error("Weather fetch failed:", e?.message || e)
      lastWeatherFetchAt = Date.now()
    } finally {
      weatherInFlight = null
    }
  })()

  try {
    await weatherInFlight
  } catch {}

  return res.json(readJSON(files.temperature) || cached)
})

app.post("/api/temperature", (req, res) => {
  const current = readJSON(files.temperature) || {}
  const next = { ...current, ...(req.body || {}), timestamp: new Date().toISOString() }
  writeJSON(files.temperature, next)
  res.json(next)
})

// ─────────────────────────────────────────────
// POIs
// ─────────────────────────────────────────────
app.get("/api/pois", (_req, res) => {
  res.json(readJSON(files.pois) || [])
})

app.post("/api/pois", (req, res) => {
  const { lat, lon, note, name } = req.body || {}
  if (typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ error: "Invalid coordinates" })
  }
  const pois = readJSON(files.pois) || []
  const item = {
    id: uuid(),
    lat: +lat,
    lon: +lon,
    note: (name ?? note ?? "").toString(),
    timestamp: new Date().toISOString(),
  }
  pois.push(item)
  writeJSON(files.pois, pois)
  res.json({ ok: true, id: item.id, count: pois.length })
})

// ─────────────────────────────────────────────
// Routesets (save is stream-safe bij NDJSON)
// ─────────────────────────────────────────────
app.get("/api/routesets", (_req, res) => {
  res.json(readJSON(files.routesets) || [])
})

async function writeRoutesetFromCurrentRoute(filePath) {
  // routeset_<id>.json moet een JSON array blijven (compat met je bestaande frontend)
  const ws = fs.createWriteStream(filePath + ".tmp", { encoding: "utf-8" })
  ws.write("[")
  let first = true
  let count = 0

  const writePoint = (p) => {
    const out = {
      lat: +p.lat,
      lon: +p.lon,
      timestamp: p.timestamp,
      alt: typeof p.alt === "number" ? p.alt : undefined,
    }
    const json = JSON.stringify(out)
    if (!first) ws.write(",")
    first = false
    ws.write(json)
    count++
  }

  if (routeFormat === "ndjson") {
    await streamRoutePointsNdjson({
      redact: false,
      onPoint: async (p) => writePoint(p),
    })
  } else {
    const points = readJSON(files.route) || []
    for (const p of points) {
      if (!p || typeof p.lat !== "number" || typeof p.lon !== "number") continue
      writePoint(p)
    }
  }

  ws.write("]")
  await new Promise((resolve) => ws.end(resolve))

  // atomic swap
  try {
    fs.renameSync(filePath + ".tmp", filePath)
  } catch {
    fs.copyFileSync(filePath + ".tmp", filePath)
    fs.unlinkSync(filePath + ".tmp")
  }

  return count
}

app.post("/api/routesets/save", async (req, res) => {
  try {
    const { name } = req.body || {}

    // check of we minimaal 2 punten hebben
    let count = 0
    if (routeFormat === "ndjson") {
      await streamRoutePointsNdjson({
        redact: false,
        onPoint: async () => {
          count++
          if (count >= 2) throw new Error("__ENOUGH__")
        },
      }).catch((e) => {
        if (e?.message !== "__ENOUGH__") throw e
      })
    } else {
      const points = readJSON(files.route) || []
      count = Array.isArray(points) ? points.length : 0
    }

    if (count < 2) return res.status(400).json({ error: "Not enough points to save" })

    const id = uuid()
    const meta = {
      id,
      name: (name || `Route ${new Date().toLocaleString()}`).toString(),
      createdAt: new Date().toISOString(),
      count: 0, // vullen na schrijven
    }

    const filePath = files.routesetFile(id)
    const writtenCount = await writeRoutesetFromCurrentRoute(filePath)
    meta.count = writtenCount

    const list = readJSON(files.routesets) || []
    list.push(meta)
    writeJSON(files.routesets, list)

    res.json({ ok: true, ...meta })
  } catch (e) {
    console.error("routesets/save failed:", e?.message || e)
    res.status(500).json({ error: "routeset save failed" })
  }
})

app.delete("/api/routesets/:id", (req, res) => {
  const { id } = req.params
  const list = readJSON(files.routesets) || []
  const idx = list.findIndex((x) => x.id === id)
  if (idx === -1) return res.status(404).json({ error: "not found" })
  list.splice(idx, 1)
  writeJSON(files.routesets, list)

  const fp = files.routesetFile(id)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
  res.json({ ok: true })
})

app.get("/api/routesets/:id", (req, res) => {
  const fp = files.routesetFile(req.params.id)
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "not found" })
  res.json(readJSON(fp) || [])
})

app.get("/api/routesets/:id/geojson", (req, res) => {
  const fp = files.routesetFile(req.params.id)
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "not found" })
  const pts = readJSON(fp) || []
  const coords = pts
    .map((p) => [p.lon, p.lat])
    .filter((a) => a.every((n) => typeof n === "number"))
  const fc = {
    type: "FeatureCollection",
    features:
      coords.length > 1
        ? [
            {
              type: "Feature",
              properties: { routesetId: req.params.id },
              geometry: { type: "LineString", coordinates: coords },
            },
          ]
        : [],
  }
  res.setHeader("Content-Type", "application/geo+json; charset=utf-8")
  res.json(fc)
})

// ─────────────────────────────────────────────
// Privacy zones + legacy compat
// ─────────────────────────────────────────────
app.get("/getPrivacyZones", (_req, res) => {
  res.json(readJSON(files.privacyZones) || [])
})

app.post("/addPrivacyZone", (req, res) => {
  const { lat, lon, radius, name } = req.body || {}
  if (typeof lat !== "number" || typeof lon !== "number" || typeof radius !== "number") {
    return res.status(400).json({ error: "lat, lon, radius required" })
  }
  const zones = readJSON(files.privacyZones) || []
  const item = {
    id: uuid(),
    lat: +lat,
    lon: +lon,
    radius: +radius,
    name: (name || "").toString(),
    createdAt: new Date().toISOString(),
  }
  zones.push(item)
  writeJSON(files.privacyZones, zones)
  // cache verversen
  privacyCache.loadedAt = 0
  res.json({ ok: true, id: item.id, count: zones.length })
})

app.delete("/removePrivacyZone/:id", (req, res) => {
  const zones = readJSON(files.privacyZones) || []
  const idx = zones.findIndex((z) => z.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: "not found" })
  zones.splice(idx, 1)
  writeJSON(files.privacyZones, zones)
  privacyCache.loadedAt = 0
  res.json({ ok: true })
})

// ─────────────────────────────────────────────
// Health (handig voor monitoring)
// ─────────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage()
  let routeBytes = 0
  try {
    routeBytes = fs.existsSync(files.route) ? fs.statSync(files.route).size : 0
  } catch {}
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    routeFormat,
    routeBytes,
    rssMB: Math.round(mem.rss / 1024 / 1024),
    heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
    dataDir: DATA_DIR,
    time: new Date().toISOString(),
  })
})

// ─────────────────────────────────────────────
// Express error middleware
// ─────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("❌ Express error:", err)
  res.status(500).json({ error: "internal_error" })
})

// ─────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────
;(function start() {
  try {
    initRouteState()

    // Zorg dat er een public geojson ligt (1x bij boot)
    void rebuildPublicRouteGeoJSON().then(() => {
      lastPublicGeojsonAt = Date.now()
    })

    const httpsOptions = loadHttpsOptions()
    https.createServer(httpsOptions, app).listen(PORT, () => {
      console.log(`✅ HTTPS actief op https://${DOMAIN}:${PORT}`)
    })

    const HTTP_PORT = Number(process.env.HTTP_PORT || 0)
    if (HTTP_PORT) {
      http
        .createServer((req, res) => {
          res.writeHead(301, { Location: `https://${DOMAIN}:${PORT}${req.url}` })
          res.end()
        })
        .listen(HTTP_PORT, () => console.log(`↪ HTTP→HTTPS redirect op :${HTTP_PORT}`))
    }
  } catch (err) {
    console.error("❌ Server start mislukt:", err.message)
    process.exit(1)
  }
})()
