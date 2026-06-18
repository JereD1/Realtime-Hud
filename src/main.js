const { app, BrowserWindow, desktopCapturer, ipcMain, screen } = require('electron');
const path = require('path');

let mainWindow;
let overlayWindow;
let lastOverlayPayload = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: 'Realtime HUD',
    backgroundColor: '#101418',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.show();
    return overlayWindow;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  overlayWindow = new BrowserWindow({
    x: primaryDisplay.workArea.x + 24,
    y: primaryDisplay.workArea.y + 24,
    width: 420,
    height: 120,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));

  overlayWindow.webContents.once('did-finish-load', () => {
    if (lastOverlayPayload) {
      overlayWindow.webContents.send('overlay:update', lastOverlayPayload);
    }
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  return overlayWindow;
}

async function getSourceById(sourceId, thumbnailSize) {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize,
    fetchWindowIcons: true,
  });

  return sources.find((source) => source.id === sourceId);
}

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 420, height: 240 },
    fetchWindowIcons: true,
  });

  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('capture:source', async (_event, sourceId) => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const source = await getSourceById(sourceId, {
    width: primaryDisplay.size.width,
    height: primaryDisplay.size.height,
  });

  if (!source) {
    throw new Error('Selected source is no longer available. Refresh windows and select it again.');
  }

  const image = source.thumbnail;
  return {
    sourceId: source.id,
    name: source.name,
    width: image.getSize().width,
    height: image.getSize().height,
    dataUrl: image.toDataURL(),
  };
});

ipcMain.handle('overlay:show', async () => {
  createOverlayWindow();
  return true;
});

ipcMain.handle('overlay:hide', async () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.hide();
  }
  return true;
});

ipcMain.on('overlay:update', (_event, payload) => {
  lastOverlayPayload = payload;
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }
  overlayWindow.webContents.send('overlay:update', payload);
});

app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
