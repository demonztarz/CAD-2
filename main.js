// Partwright desktop shell: serves the bundled app over a private app:// scheme
// (so the modelling worker and its WebAssembly load the same way as on the web),
// and gives the page native file dialogs.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'build');
const DOC_EXT = ['.pwd'];
const IMPORT_EXT = ['.step', '.stp', '.stl'];
let win;
let forceClose = false;

// 3D needs WebGL; don't let Chromium's driver blocklist switch it off on older or virtual GPUs
// (it falls back to software rendering when there is no usable GPU at all).
app.commandLine.appendSwitch('ignore-gpu-blocklist');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveApp() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

function send(cmd) { if (win) win.webContents.send('menu', cmd); }

function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'New', click: () => send('NEW') },
      { label: 'Open…', click: () => send('OPEN') },
      { type: 'separator' },
      { label: 'Save', click: () => send('SAVE') },
      { label: 'Save As…', click: () => send('SAVEAS') },
      { type: 'separator' },
      { label: 'Import STEP / STL…', click: () => send('IMPORT') },
      { label: 'Export STEP…', click: () => send('EXPORTSTEP') },
      { label: 'Export STL…', click: () => send('EXPORTSTL') },
      { type: 'separator' },
      { label: isMac ? 'Close Window' : 'Exit', click: () => send('APP_CLOSE') },
    ] },
    { label: 'Edit', submenu: [{ label: 'Undo', click: () => send('UNDO') }, { label: 'Redo', click: () => send('REDO') }] },
    { label: 'View', submenu: [{ label: 'Zoom to Fit', click: () => send('FIT') }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Help', submenu: [{ label: 'Shortcuts', click: () => send('HELP') }, { label: `Partwright ${app.getVersion()}`, enabled: false }] },
  ]));
}

function readForPage(filePath, binary) {
  const ext = path.extname(filePath).toLowerCase();
  const asBase64 = binary === true || (binary === 'auto' && ext === '.stl');
  const buf = fs.readFileSync(filePath);
  return { path: filePath, name: path.basename(filePath), data: asBase64 ? buf.toString('base64') : buf.toString('utf8') };
}

function createWindow(fileToOpen) {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 620,
    backgroundColor: '#f5f7fa', title: 'Partwright', autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL('app://partwright/index.html');
  win.webContents.on('did-finish-load', () => {
    if (!fileToOpen) return;
    try { win.webContents.send('file-opened', readForPage(fileToOpen, 'auto')); } catch (err) { dialog.showErrorBox('Partwright', `Could not open ${fileToOpen}: ${err.message}`); }
    fileToOpen = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => { if (forceClose) return; e.preventDefault(); send('APP_CLOSE'); });
}

ipcMain.handle('open-file', async (_e, { filters, binary }) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters });
  if (r.canceled || !r.filePaths.length) return null;
  return readForPage(r.filePaths[0], binary);
});
ipcMain.handle('save-dialog', async (_e, { name, filters }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('write-file', async (_e, { path: p, data }) => {
  await fs.promises.writeFile(p, typeof data === 'string' ? data : Buffer.from(data));
  return true;
});
ipcMain.handle('confirm-discard', async () => {
  const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Discard changes', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Discard unsaved changes?', detail: 'The current part studio has changes that have not been saved.' });
  return r.response === 0;
});
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.on('set-title', (_e, t) => { if (win) win.setTitle(t); });
ipcMain.on('really-close', () => { forceClose = true; if (win) win.close(); });

const fileArg = (argv) => argv.slice(1).find((a) => !a.startsWith('-') && [...DOC_EXT, ...IMPORT_EXT].includes(path.extname(a).toLowerCase()) && fs.existsSync(a));

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = fileArg(argv);
    if (f) win.webContents.send('file-opened', readForPage(f, 'auto'));
  });
  app.whenReady().then(() => {
    serveApp();
    buildMenu();
    createWindow(fileArg(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
