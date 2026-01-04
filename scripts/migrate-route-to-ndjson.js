#!/usr/bin/env node
/**
 * migrate-route-to-ndjson.js
 * Zet een legacy JSON-array routeData.json om naar NDJSON (1 JSON object per regel),
 * zonder de hele file in RAM te gooien.
 *
 * Usage:
 *   node scripts/migrate-route-to-ndjson.js data/routeData.json
 *
 * Output:
 *   - maakt een backup: routeData.json.bak-YYYYMMDDHHMMSS
 *   - schrijft nieuwe NDJSON naar routeData.json (zelfde naam)
 */
const fs = require("fs")
const path = require("path")

const inputPath = process.argv[2]
if (!inputPath) {
  console.error("Usage: node scripts/migrate-route-to-ndjson.js <path-to-routeData.json>")
  process.exit(1)
}

if (!fs.existsSync(inputPath)) {
  console.error("File not found:", inputPath)
  process.exit(1)
}

function ts() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, "0")
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

const dir = path.dirname(inputPath)
const base = path.basename(inputPath)
const tmpPath = path.join(dir, base + ".ndjson.tmp")
const bakPath = path.join(dir, base + `.bak-${ts()}`)

const rs = fs.createReadStream(inputPath, { encoding: "utf-8" })
const ws = fs.createWriteStream(tmpPath, { encoding: "utf-8" })

let buf = ""
let startedArray = false
let inString = false
let escape = false
let depth = 0
let objStart = -1
let count = 0

function isWhitespace(ch) {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t"
}

function flushProcessed(n) {
  if (n > 0) buf = buf.slice(n)
}

function processBuffer(isFinal = false) {
  let i = 0

  while (i < buf.length) {
    const ch = buf[i]

    // Zoek begin array
    if (!startedArray) {
      if (isWhitespace(ch)) {
        i++
        continue
      }
      if (ch !== "[") {
        throw new Error("Input lijkt geen JSON array te zijn (eerste non-whitespace is niet '[').")
      }
      startedArray = true
      i++
      flushProcessed(i)
      i = 0
      continue
    }

    // Als we niet in een object zitten: skip commas/whitespace en zoek '{' of ']'
    if (depth === 0 && objStart === -1) {
      if (isWhitespace(ch) || ch === ",") {
        i++
        continue
      }
      if (ch === "]") {
        // klaar
        flushProcessed(i + 1)
        return
      }
      if (ch === "{") {
        objStart = i
        depth = 1
        inString = false
        escape = false
        i++
        continue
      }
      // Onverwacht teken
      throw new Error(`Onverwacht teken buiten object: '${ch}' (pos ${i})`)
    }

    // Binnen een object: brace depth tracken, strings respecteren
    if (objStart !== -1) {
      if (inString) {
        if (escape) {
          escape = false
        } else if (ch === "\\\\") {
          escape = true
        } else if (ch === '"') {
          inString = false
        }
        i++
        continue
      } else {
        if (ch === '"') {
          inString = true
          i++
          continue
        }
        if (ch === "{") {
          depth++
          i++
          continue
        }
        if (ch === "}") {
          depth--
          i++
          if (depth === 0) {
            // Object is compleet: slice, parse, schrijf line
            const objStr = buf.slice(objStart, i)
            let obj
            try {
              obj = JSON.parse(objStr)
            } catch (e) {
              throw new Error("JSON.parse faalde op object rond pos " + objStart + ": " + e.message)
            }
            ws.write(JSON.stringify(obj) + "\n")
            count++

            // drop tot i, reset state, ga door
            flushProcessed(i)
            i = 0
            objStart = -1
            inString = false
            escape = false
            depth = 0
            continue
          }
          continue
        }
        // ander teken
        i++
        continue
      }
    }

    i++
  }

  // buffer is op; in incomplete object houden we alles vast
  if (!isFinal) {
    // om runaway memory te voorkomen: als we NIET in object zitten, kunnen we alles flushen
    if (objStart === -1) buf = ""
  }
}

rs.on("data", (chunk) => {
  buf += chunk
  try {
    processBuffer(false)
  } catch (e) {
    console.error("❌ Migration failed:", e.message)
    rs.destroy(e)
  }
})

rs.on("end", () => {
  try {
    processBuffer(true)
    ws.end(() => {
      // vervang files
      fs.renameSync(inputPath, bakPath)
      fs.renameSync(tmpPath, inputPath)
      console.log(`✅ Migratie klaar: ${count} punten`)
      console.log(`🗄️ Backup: ${bakPath}`)
      console.log("👉 Tip: start server en run /api/route/rebuild-geojson (of reboot) om route_public.geojson te refreshen.")
    })
  } catch (e) {
    console.error("❌ Migration failed at end:", e.message)
    process.exit(1)
  }
})

rs.on("error", (e) => {
  console.error("❌ Read error:", e.message)
  process.exit(1)
})

ws.on("error", (e) => {
  console.error("❌ Write error:", e.message)
  process.exit(1)
})
