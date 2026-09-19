const { app, BrowserWindow } = require('electron')
const path = require('path')

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'MAGI INTELLIGENCE',
    backgroundColor: '#e8d8c9',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Same-origin/CORS enforcement stays on. The renderer only ever talks
      // to server.js (CONFIG.API_URL) — never directly to Ollama/SearXNG —
      // so nothing here depends on webSecurity being off, and leaving it on
      // means a compromised/malicious page in this window can't freely
      // fetch() arbitrary origins.
      webSecurity: true
    },
    // Remove default menu bar
    autoHideMenuBar: true,
  })

  win.loadFile('index.html')
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
