const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron')
const path = require('path')
const fs   = require('fs')

let mainWindow
let overlayWindow

// ── Tuning constants ──────────────────────────────────────────────────────
const WINDOW_SIZE        = 40    // frames in rolling baseline (~5s at 120ms poll)
const DEAD_SIGMA         = 2.2   // σ below mean to call dead
const ALIVE_SIGMA        = 1.2   // σ below mean to call revived
const MIN_STDDEV         = 8     // floor so very stable cards still trigger
const CONSISTENCY_FRAMES = 3     // consecutive frames required before state flips
const COOLDOWN_MS        = 1500  // lockout ms after a state change fires
const ORANGE_PIXEL_RATIO = 0.05  // >5% orange pixels = low health, skip death
const DEAD_SIM_THRESHOLD = 0.52  // template similarity must exceed this to confirm dead

// ── Dead template (loaded once at startup) ────────────────────────────────
// Stored as flat Float32 luminance array for fast comparison
let deadTemplate = null  // { pixels: Float32Array, width, height }
let aliveTemplate = null

function loadTemplates() {
  const assetsDir = path.join(__dirname, '..', 'assets')
  try {
    const deadBuf  = fs.readFileSync(path.join(assetsDir, 'dead.png'))
    const aliveBuf = fs.readFileSync(path.join(assetsDir, 'alive.png'))
    // Parse raw PNG to RGBA using Electron's nativeImage
    const { nativeImage } = require('electron')
    const deadImg  = nativeImage.createFromBuffer(deadBuf)
    const aliveImg = nativeImage.createFromBuffer(aliveBuf)
    const ds = deadImg.getSize()
    const as = aliveImg.getSize()
    deadTemplate  = { pixels: toLuminance(deadImg.getBitmap()),  width: ds.width, height: ds.height }
    aliveTemplate = { pixels: toLuminance(aliveImg.getBitmap()), width: as.width, height: as.height }
    console.log(`Templates loaded — dead: ${ds.width}x${ds.height}, alive: ${as.width}x${as.height}`)
  } catch (e) {
    console.warn('Templates not loaded:', e.message)
  }
}

// Convert RGBA buffer to Float32 luminance array (0–255)
function toLuminance(buf) {
  const out = new Float32Array(buf.length / 4)
  for (let i = 0; i < buf.length; i += 4) {
    out[i >> 2] = buf[i] * 0.299 + buf[i+1] * 0.587 + buf[i+2] * 0.114
  }
  return out
}

// Nearest-neighbour resize of a luminance array to target dimensions
function resizeLuminance(pixels, srcW, srcH, dstW, dstH) {
  const out = new Float32Array(dstW * dstH)
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const sx = Math.floor((x / dstW) * srcW)
      const sy = Math.floor((y / dstH) * srcH)
      out[y * dstW + x] = pixels[sy * srcW + sx]
    }
  }
  return out
}

// Normalised cross-correlation similarity (0–1) between two same-size luminance arrays
// Ignores absolute brightness differences — only checks structural pattern match
function nccSimilarity(a, b) {
  let sumA = 0, sumB = 0
  const n = a.length
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i] }
  const mA = sumA / n
  const mB = sumB / n
  let num = 0, denA = 0, denB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA
    const db = b[i] - mB
    num  += da * db
    denA += da * da
    denB += db * db
  }
  const den = Math.sqrt(denA * denB)
  return den < 1e-6 ? 0 : (num / den + 1) / 2  // map -1…1 to 0…1
}

// ── Orange / low-health detector ──────────────────────────────────────────
// Orange pixels: R clearly dominant, G moderate, B low
// Works regardless of overall bar length (half-bar still has orange pixels)
function isLowHealth(buffer) {
  let orangeCount = 0
  const total = buffer.length / 4
  for (let i = 0; i < buffer.length; i += 4) {
    const r = buffer[i], g = buffer[i+1], b = buffer[i+2]
    // Orange signature: R > 140, R/B ratio > 2.0, R > G * 1.1
    if (r > 140 && r > b * 2.0 && r > g * 1.1) orangeCount++
  }
  return (orangeCount / total) >= ORANGE_PIXEL_RATIO
}

// ── Perceptual brightness ─────────────────────────────────────────────────
function avgBrightness(buffer) {
  let total = 0, count = 0
  for (let i = 0; i < buffer.length; i += 4) {
    total += buffer[i] * 0.299 + buffer[i+1] * 0.587 + buffer[i+2] * 0.114
    count++
  }
  return count > 0 ? total / count : 0
}

// ── Rolling stats ─────────────────────────────────────────────────────────
function mean(arr)          { return arr.reduce((a, b) => a + b, 0) / arr.length }
function stddev(arr, mu)    { return Math.sqrt(arr.reduce((a, b) => a + (b - mu) ** 2, 0) / arr.length) }

// ── Player state ──────────────────────────────────────────────────────────
const playerStates = {}
const teamAlive = { 0: [true,true,true,true,true], 1: [true,true,true,true,true] }

function makeState(teamIndex, playerIndex) {
  return {
    teamIndex, playerIndex,
    isDead: false,
    cooldown: false,
    samples: [],
    consecutiveDead:  0,
    consecutiveAlive: 0,
  }
}

// ── Layouts persistence ───────────────────────────────────────────────────
function layoutsPath() { return path.join(app.getPath('userData'), 'layouts.json') }
function loadLayouts() {
  try {
    const p = layoutsPath()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch(e) {}
  return {}
}
function saveLayouts(layouts) {
  try { fs.writeFileSync(layoutsPath(), JSON.stringify(layouts, null, 2)) } catch(e) {}
}

ipcMain.handle('get-layouts',   ()                    => loadLayouts())
ipcMain.handle('save-layout',   (_, { windowName, regions }) => {
  const layouts = loadLayouts()
  layouts[windowName] = { windowName, regions, savedAt: new Date().toISOString() }
  saveLayouts(layouts); return { ok: true }
})
ipcMain.handle('delete-layout', (_, { windowName }) => {
  const layouts = loadLayouts()
  delete layouts[windowName]; saveLayouts(layouts); return { ok: true }
})

// ── Windows ───────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 700, minWidth: 560, minHeight: 500,
    titleBarStyle: 'hiddenInset', backgroundColor: '#0d0e12', title: 'Health Capture',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.on('closed', () => app.quit())
}

function createOverlay(sourceId, displayBounds) {
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null }
  const target = displayBounds || screen.getPrimaryDisplay().bounds
  overlayWindow = new BrowserWindow({
    width: target.width, height: target.height, x: target.x, y: target.y,
    transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))
  overlayWindow.setIgnoreMouseEvents(false)
  overlayWindow.webContents.once('did-finish-load', () => {
    overlayWindow.webContents.send('init-overlay', {
      sourceId, offsetX: target.x, offsetY: target.y,
      totalWidth: target.width, totalHeight: target.height,
    })
  })
  overlayWindow.on('closed', () => { overlayWindow = null })
}

ipcMain.handle('get-sources', async () => {
  const sources  = await desktopCapturer.getSources({ types: ['window','screen'], thumbnailSize: { width: 320, height: 200 } })
  const displays = screen.getAllDisplays()
  const primary  = screen.getPrimaryDisplay()
  return sources.map(s => {
    let displayBounds = primary.bounds
    const screenMatch = s.id.match(/^screen:(\d+):/)
    if (screenMatch) {
      const matched = displays[parseInt(screenMatch[1], 10)]
      if (matched) displayBounds = matched.bounds
    } else {
      displayBounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
    }
    return { id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(),
             displays: displays.map(d => d.bounds), primary: primary.bounds, displayBounds }
  })
})

ipcMain.handle('get-stream-id', async (_, sourceId) => sourceId)

ipcMain.on('open-region-selector', (_, { sourceId, displayBounds }) => {
  const target = displayBounds || screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
  createOverlay(sourceId, target)
})
ipcMain.on('region-confirmed',  (_, data) => {
  if (overlayWindow) { overlayWindow.close(); overlayWindow = null }
  mainWindow.webContents.send('region-set', data)
})
ipcMain.on('overlay-cancelled', () => { if (overlayWindow) { overlayWindow.close(); overlayWindow = null } })

// Templates ready — now backed by actual assets
ipcMain.handle('templates-ready', () => ({
  ready: deadTemplate !== null,
  hasAlive: aliveTemplate !== null,
}))

// ── Player registration ───────────────────────────────────────────────────
ipcMain.on('register-player', (_, { teamIndex, playerIndex }) => {
  playerStates[`${teamIndex}-${playerIndex}`] = makeState(teamIndex, playerIndex)
})

ipcMain.handle('save-alive-template', (_, { teamIndex, playerIndex, buffer }) => {
  const key = `${teamIndex}-${playerIndex}`
  if (!playerStates[key]) playerStates[key] = makeState(teamIndex, playerIndex)
  const brightness = avgBrightness(Buffer.from(buffer))
  const state = playerStates[key]
  state.samples = Array(WINDOW_SIZE).fill(brightness)
  state.isDead  = false
  state.consecutiveDead  = 0
  state.consecutiveAlive = 0
  console.log(`Baseline seeded [${teamIndex}-${playerIndex}]: brightness=${brightness.toFixed(1)}`)
  return { ok: true, brightness }
})

ipcMain.on('unregister-player', (_, { teamIndex, playerIndex }) => {
  delete playerStates[`${teamIndex}-${playerIndex}`]
  teamAlive[teamIndex][playerIndex] = true
})

// ── Batched analysis ──────────────────────────────────────────────────────
ipcMain.handle('analyse-batch', (_, { players, endpoint }) => {
  const changes = []

  for (const { teamIndex, playerIndex, buffer, width, height } of players) {
    const key   = `${teamIndex}-${playerIndex}`
    const state = playerStates[key]
    if (!state || state.cooldown) continue

    const raw        = Buffer.from(buffer)
    const brightness = avgBrightness(raw)

    // ── 1. ORANGE CHECK — low health bar, never dead ──────────────────────
    const lowHealth = isLowHealth(raw)

    // ── 2. TEMPLATE SIMILARITY against dead.png ───────────────────────────
    let deadSim = 0
    if (deadTemplate && !lowHealth) {
      const srcW   = width  || Math.round(raw.length / 4 / 8)   // fallback if not sent
      const srcH   = height || 8
      const lum    = toLuminance(raw)
      const scaled = resizeLuminance(lum, srcW, srcH, deadTemplate.width, deadTemplate.height)
      deadSim = nccSimilarity(scaled, deadTemplate.pixels)
    }

    // ── 3. WARM-UP — accumulate baseline frames ───────────────────────────
    if (state.samples.length < 5) {
      if (!lowHealth) state.samples.push(brightness)
      if (state.samples.length > WINDOW_SIZE) state.samples.shift()
      mainWindow.webContents.send('match-scores', {
        teamIndex, playerIndex, brightness: Math.round(brightness),
        mean: Math.round(brightness), deadThreshold: 0,
        consecutiveDead: 0, lowHealth, deadSim: 0, status: 'warming',
      })
      continue
    }

    // ── 4. PER-PLAYER ROLLING STATS ───────────────────────────────────────
    const mu  = mean(state.samples)
    const sd  = Math.max(stddev(state.samples, mu), MIN_STDDEV)
    const deadThreshold  = mu - DEAD_SIGMA  * sd
    const aliveThreshold = mu - ALIVE_SIGMA * sd

    // ── 5. CONSECUTIVE FRAME COUNTERS ─────────────────────────────────────
    if (!state.isDead) {
      if (lowHealth) {
        // Orange bar — reset death streak, update baseline normally
        state.consecutiveDead = 0
        state.samples.push(brightness)
        if (state.samples.length > WINDOW_SIZE) state.samples.shift()
      } else if (brightness < deadThreshold && deadSim >= DEAD_SIM_THRESHOLD) {
        // Both signals agree: brightness dropped AND looks like dead template
        state.consecutiveDead++
        state.consecutiveAlive = 0
      } else if (brightness < deadThreshold && !deadTemplate) {
        // No template loaded — fall back to brightness alone
        state.consecutiveDead++
        state.consecutiveAlive = 0
      } else {
        state.consecutiveDead = 0
        if (brightness >= aliveThreshold) {
          state.samples.push(brightness)
          if (state.samples.length > WINDOW_SIZE) state.samples.shift()
        }
      }
    } else {
      // Currently dead — watching for revival
      if (brightness > aliveThreshold) {
        state.consecutiveAlive++
        state.consecutiveDead = 0
      } else {
        state.consecutiveAlive = 0
      }
    }

    // ── 6. STATE FLIP ─────────────────────────────────────────────────────
    let flipped = false

    if (!state.isDead && state.consecutiveDead >= CONSISTENCY_FRAMES) {
      state.isDead = true
      state.consecutiveDead  = 0
      state.consecutiveAlive = 0
      teamAlive[teamIndex][playerIndex] = false
      changes.push({ teamIndex, playerIndex, isDead: true })
      flipped = true
    }

    if (state.isDead && state.consecutiveAlive >= CONSISTENCY_FRAMES) {
      state.isDead = false
      state.consecutiveDead  = 0
      state.consecutiveAlive = 0
      // Re-seed so we don't compare against pre-death mean
      state.samples = Array(WINDOW_SIZE).fill(brightness)
      teamAlive[teamIndex][playerIndex] = true
      changes.push({ teamIndex, playerIndex, isDead: false })
      flipped = true
    }

    if (flipped) {
      state.cooldown = true
      setTimeout(() => { if (playerStates[key]) playerStates[key].cooldown = false }, COOLDOWN_MS)
    }

    // ── 7. DEBUG TO UI ────────────────────────────────────────────────────
    mainWindow.webContents.send('match-scores', {
      teamIndex, playerIndex,
      brightness:       Math.round(brightness),
      mean:             Math.round(mu),
      stddev:           Math.round(sd),
      deadThreshold:    Math.round(deadThreshold),
      aliveThreshold:   Math.round(aliveThreshold),
      consecutiveDead:  state.consecutiveDead,
      consecutiveAlive: state.consecutiveAlive,
      nowDead:          state.isDead,
      lowHealth,
      deadSim:          Math.round(deadSim * 100),
      status:           lowHealth ? 'low' : state.isDead ? 'dead' : 'alive',
    })
  }

  if (changes.length > 0) {
    changes.forEach(c => mainWindow.webContents.send('state-change', c))
    firePost(endpoint, [...teamAlive[0]], [...teamAlive[1]])
  }

  return { ok: true, changes: changes.length }
})

ipcMain.handle('analyse-frame', () => ({ skip: true }))

// ── Reset ─────────────────────────────────────────────────────────────────
ipcMain.on('reset-all', () => {
  Object.keys(playerStates).forEach(k => delete playerStates[k])
  teamAlive[0] = [true,true,true,true,true]
  teamAlive[1] = [true,true,true,true,true]
})

ipcMain.on('set-all-alive', (_, { endpoint }) => {
  teamAlive[0] = [true,true,true,true,true]
  teamAlive[1] = [true,true,true,true,true]
  Object.values(playerStates).forEach(s => {
    s.isDead = false; s.cooldown = false
    s.consecutiveDead = 0; s.consecutiveAlive = 0; s.samples = []
  })
  firePost(endpoint, [true,true,true,true,true], [true,true,true,true,true])
  mainWindow.webContents.send('all-alive-sent')
})

// ── POST ──────────────────────────────────────────────────────────────────
function firePost(endpoint, team1Alive, team2Alive) {
  if (!endpoint) return
  fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team1AliveStatus: team1Alive, team2AliveStatus: team2Alive }),
  })
  .then(res => mainWindow?.webContents.send('post-result', { ok: res.ok, status: res.status }))
  .catch(err => mainWindow?.webContents.send('post-error', `POST failed: ${err.message}`))
}

app.whenReady().then(() => {
  loadTemplates()
  createMainWindow()
})
app.on('window-all-closed', () => app.quit())
