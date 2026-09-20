import { readFileSync } from 'node:fs'

const files = process.argv.slice(2)
if (!files.length) throw new Error('Pass one or more attempt JSONL files')
const rows = files.flatMap(file => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
const windows = [1, 60, 300, 600, 1800, 3600]
const firstRejection = rows.filter(row => row.error || row.status !== 200 && row.status !== 304).sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt))[0]
const latestCompleted = Math.max(...rows.map(row => Date.parse(row.completedAt)))
const spanSeconds = (latestCompleted - Date.parse(rows[0].startedAt)) / 1000
const result = {
  attempts: rows.length,
  spanSeconds,
  statuses: rows.reduce((all, row) => ({ ...all, [row.status ?? 'error']: (all[row.status ?? 'error'] ?? 0) + 1 }), {}),
  maxInFlight: Math.max(...rows.map(row => row.inFlightAtDispatch ?? 1)),
  bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
  firstRejection,
  windows: windows.map(seconds => {
    let left = 0
    let maximum = 0
    let peakEndingAt = null
    for (let right = 0; right < rows.length; right++) {
      const end = Date.parse(rows[right].startedAt)
      while (Date.parse(rows[left].startedAt) <= end - seconds * 1000) left++
      if (right - left + 1 > maximum) {
        maximum = right - left + 1
        peakEndingAt = rows[right].startedAt
      }
    }
    const atRejection = firstRejection ? rows.filter(row => {
      const time = Date.parse(row.startedAt)
      const rejectedAt = Date.parse(firstRejection.completedAt)
      return time > rejectedAt - seconds * 1000 && time <= rejectedAt
    }) : []
    return { seconds, wholeWindowElapsed: spanSeconds >= seconds, maximumKnownStarts: maximum, peakEndingAt, ...(firstRejection ? { knownStartsBeforeRejectionResponse: atRejection.length, tileStarts: atRejection.filter(row => row.route === 'tile').length, pixelStarts: atRejection.filter(row => row.route === 'pixel').length } : {}) }
  }),
}
console.log(JSON.stringify(result, null, 2))
