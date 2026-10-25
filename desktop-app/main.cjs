// App Jarvis para macOS (Electron). Embrulha o HUD que o servidor local serve e acrescenta o que um
// navegador não dá: camada transparente por cima de todos os monitores (esfera mini no canto, esfera que
// voa até o que ele está olhando), ícone na barra de menus, atalho global ⌥ Espaço, abrir no login,
// voz e câmera sem freio com a janela escondida, e atualização com animação.

const { app, BrowserWindow, Menu, Tray, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen, session, shell, systemPreferences } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BASE = process.env.JARVIS_URL || 'http://localhost:8000'
const PROJETO = require('./package.json').jarvis?.projeto || path.resolve(__dirname, '..')
const PATH_EXTRA = [path.join(process.env.HOME || '', '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin'].join(':')

let hud = null
let tray = null
let quitting = false
let server = null // servidor iniciado pelo app (quando o serviço do macOS não está rodando)
const overlays = new Map() // id do monitor -> janela da camada

// depuração: JARVIS_DEBUG=1 abre a porta do DevTools só no próprio Mac
if (process.env.JARVIS_DEBUG) app.commandLine.appendSwitch('remote-debugging-port', '9333')

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showHud())

/* ---------- servidor ---------- */

async function healthy() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

function startServer() {
  // sem o serviço do macOS, o próprio app sobe o servidor (e o reinicia se cair)
  server = spawn('uv', ['run', '--directory', path.join(PROJETO, 'backend'), 'uvicorn', 'jarvis.app:app', '--host', '127.0.0.1', '--port', '8000'], {
    env: { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH}`, JARVIS_APP_CHILD: '1' },
    stdio: 'ignore',
  })
  server.on('exit', () => {
    server = null
    if (!quitting) setTimeout(startServer, 1500)
  })
}

const UID = process.getuid?.() ?? 501
const SERVICO = `gui/${UID}/com.jarvis.servidor`

function sh(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { stdio: 'ignore' })
    p.on('exit', (code) => res(code))
    p.on('error', () => res(-1))
  })
}

// O servidor roda DENTRO do app: assim o macOS atribui as permissões (Acessibilidade, Gravação de Tela) ao
// "Jarvis", e não a um "Python" difícil de achar. O serviço antigo do launchd é desligado (reversível com
// `launchctl enable` + `launchctl bootstrap`).
async function takeOverServer() {
  await sh('/bin/launchctl', ['disable', SERVICO])
  await sh('/bin/launchctl', ['bootout', SERVICO])
  for (let i = 0; i < 20 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 300))
}

async function ensureServer() {
  if (!server) await takeOverServer()
  if (await healthy()) return true
  startServer()
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await healthy()) return true
  }
  return false
}

/* ---------- janelas ---------- */

const preload = path.join(__dirname, 'preload.cjs')

// visivel: HUD na tela · minimizado: esfera no canto · oculto: só o ícone na barra de menus
function hudState() {
  const modo = !hud ? 'oculto' : hud.isMinimized() ? 'minimizado' : hud.isVisible() ? 'visivel' : 'oculto'
  return { visible: modo === 'visivel', modo, focused: !!hud && hud.isFocused(), bounds: hud ? hud.getBounds() : null }
}

function broadcastHud() {
  const s = hudState()
  for (const w of overlays.values()) if (!w.isDestroyed()) w.webContents.send('hud-state', s)
  if (hud && !hud.isDestroyed()) hud.webContents.send('hud-state', s)
}

// aberto pelo login do Mac? Então fica escondido (só o ícone) até ser chamado
async function openedAtLogin() {
  if (app.getLoginItemSettings().wasOpenedAtLogin) return true
  return new Promise((res) => {
    const ps = spawn('/bin/sh', ['-c', 'ps -o etimes= -p $(pgrep -x loginwindow | head -1)'])
    let out = ''
    ps.stdout.on('data', (d) => (out += d))
    ps.on('exit', () => res(Number(out.trim()) < 180))
    ps.on('error', () => res(false))
  })
}

function createHud(hidden = false) {
  const area = screen.getPrimaryDisplay().workArea
  hud = new BrowserWindow({
    ...area,
    show: false,
    title: 'Jarvis',
    backgroundColor: '#030a1a',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload, backgroundThrottling: false },
  })
  hud.loadURL(`${BASE}/?inicio=1&app=1`)
  hud.once('ready-to-show', () => {
    if (!hidden) hud.show()
    broadcastHud()
  })
  for (const ev of ['minimize', 'restore', 'hide', 'show', 'move', 'resize', 'focus', 'blur']) hud.on(ev, broadcastHud)
  // fechar a janela só esconde: a voz continua e a esfera vai para o canto
  hud.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    hud.hide()
  })
  // links externos abrem no navegador padrão
  hud.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE)) return { action: 'allow' }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

function createOverlays() {
  const keep = new Set()
  const primary = screen.getPrimaryDisplay().id
  for (const d of screen.getAllDisplays()) {
    keep.add(d.id)
    const b = d.bounds
    let w = overlays.get(d.id)
    if (!w || w.isDestroyed()) {
      w = new BrowserWindow({
        ...b,
        transparent: true,
        frame: false,
        hasShadow: false,
        focusable: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        enableLargerThanScreen: true,
        alwaysOnTop: true,
        webPreferences: { preload, backgroundThrottling: false },
      })
      w.setAlwaysOnTop(true, 'screen-saver')
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      w.setIgnoreMouseEvents(true, { forward: true })
      w.webContents.on('did-finish-load', () => w.webContents.send('hud-state', hudState()))
      overlays.set(d.id, w)
    }
    w.setBounds(b)
    w.loadURL(`${BASE}/overlay?x=${b.x}&y=${b.y}&w=${b.width}&h=${b.height}&main=${d.id === primary ? 1 : 0}`)
    w.showInactive()
  }
  for (const [id, w] of overlays) {
    if (!keep.has(id)) {
      w.destroy()
      overlays.delete(id)
    }
  }
  app.dock?.show() // a camada em tela cheia às vezes some com o ícone do Dock
}

function showHud() {
  if (!hud) return
  if (hud.isMinimized()) hud.restore()
  hud.show()
  hud.focus()
}

function toggleHud() {
  if (hud && hud.isVisible() && !hud.isMinimized() && hud.isFocused()) hud.minimize()
  else showHud()
}

/* ---------- permissões ---------- */

function setupPermissions() {
  const ok = new Set(['media', 'microphone', 'camera', 'display-capture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(ok.has(perm)))
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ok.has(perm))
  // "compartilhar a tela" com o Jarvis: entrega o monitor principal sem caixa de escolha
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const fontes = await desktopCapturer.getSources({ types: ['screen'] })
    cb({ video: fontes[0] })
  })
  systemPreferences.askForMediaAccess('microphone').catch(() => {})
  systemPreferences.askForMediaAccess('camera').catch(() => {})
}

/* ---------- barra de menus ---------- */

async function checkUpdate(interactive = true) {
  try {
    const info = await (await fetch(`${BASE}/api/atualizacao`)).json()
    if (!info.disponivel) {
      if (interactive) dialog.showMessageBox({ message: 'O Jarvis está atualizado.', detail: `Versão ${info.versao}${info.motivo ? `\n${info.motivo}` : ''}` })
      return
    }
    const r = await dialog.showMessageBox({
      message: `Nova versão do Jarvis: ${info.nova}`,
      detail: (info.mudancas || []).slice(0, 6).map((m) => `• ${m}`).join('\n'),
      buttons: ['Atualizar agora', 'Depois'],
      defaultId: 0,
    })
    if (r.response === 0) {
      showHud()
      await fetch(`${BASE}/api/atualizacao/aplicar`, { method: 'POST' })
    }
  } catch (e) {
    if (interactive) dialog.showMessageBox({ type: 'warning', message: 'Não consegui verificar atualizações.', detail: String(e) })
  }
}

function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'))
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Jarvis')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: 'Mostrar o Jarvis', accelerator: 'Alt+Space', click: showHud },
      { label: 'Ficar no canto', click: () => hud?.minimize() },
      { type: 'separator' },
      { label: 'Painel', click: () => openPanel() },
      { label: 'Procurar atualização…', click: () => checkUpdate(true) },
      { type: 'separator' },
      {
        label: 'Abrir ao entrar no Mac',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (it) => app.setLoginItemSettings({ openAtLogin: it.checked }),
      },
      { label: `Versão ${app.getVersion()}`, enabled: false },
      { label: 'Sair do Jarvis', accelerator: 'Cmd+Q', click: () => app.quit() },
    ])
  tray.on('click', () => tray.popUpContextMenu(menu()))
  tray.on('right-click', () => tray.popUpContextMenu(menu()))
}

let panel = null
function openPanel() {
  if (panel && !panel.isDestroyed()) return panel.focus()
  panel = new BrowserWindow({ width: 1360, height: 880, title: 'Jarvis · Painel', backgroundColor: '#05080f', webPreferences: { preload } })
  panel.loadURL(`${BASE}/admin`)
}

/* ---------- IPC ---------- */

ipcMain.on('ov:ignore', (e, ignore) => BrowserWindow.fromWebContents(e.sender)?.setIgnoreMouseEvents(!!ignore, { forward: true }))
ipcMain.on('hud:minimize', () => hud?.minimize())
ipcMain.on('hud:hide', () => hud?.hide())
ipcMain.on('hud:show', showHud)
ipcMain.on('app:update', () => {
  // a casca do app mudou: recompila e reinstala em /Applications, depois reabre
  const script = path.join(PROJETO, 'scripts', 'instalar-app.sh')
  if (!fs.existsSync(script)) return
  spawn('/bin/bash', [script, '--reabrir'], { detached: true, stdio: 'ignore', env: { ...process.env, PATH: `${PATH_EXTRA}:${process.env.PATH}` } }).unref()
  quitting = true
  setTimeout(() => app.quit(), 500)
})

/* ---------- ciclo de vida ---------- */

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Jarvis',
        submenu: [
          { role: 'about', label: 'Sobre o Jarvis' },
          { label: 'Procurar atualização…', click: () => checkUpdate(true) },
          { type: 'separator' },
          { label: 'Painel', accelerator: 'Cmd+,', click: () => openPanel() },
          { type: 'separator' },
          { role: 'hide', label: 'Ocultar o Jarvis' },
          { role: 'hideOthers', label: 'Ocultar os outros' },
          { type: 'separator' },
          { role: 'quit', label: 'Sair do Jarvis' },
        ],
      },
      {
        label: 'Editar',
        submenu: [
          { role: 'undo', label: 'Desfazer' },
          { role: 'redo', label: 'Refazer' },
          { type: 'separator' },
          { role: 'cut', label: 'Cortar' },
          { role: 'copy', label: 'Copiar' },
          { role: 'paste', label: 'Colar' },
          { role: 'selectAll', label: 'Selecionar tudo' },
        ],
      },
      {
        label: 'Visualizar',
        submenu: [
          { role: 'reload', label: 'Recarregar' },
          { role: 'togglefullscreen', label: 'Tela cheia' },
          { type: 'separator' },
          { role: 'toggleDevTools', label: 'Ferramentas de desenvolvedor' },
        ],
      },
      {
        label: 'Janela',
        submenu: [
          { label: 'Ficar no canto', accelerator: 'Cmd+M', click: () => hud?.minimize() },
          { label: 'Mostrar o Jarvis', accelerator: 'Alt+Space', click: showHud },
          { role: 'close', label: 'Fechar janela' },
        ],
      },
    ]),
  )
}

app.whenReady().then(async () => {
  app.setName('Jarvis')
  buildMenu()
  const first = path.join(app.getPath('userData'), '.configurado')
  if (!fs.existsSync(first)) {
    app.setLoginItemSettings({ openAtLogin: true })
    fs.writeFileSync(first, '1')
  }
  setupPermissions()
  // pede a Acessibilidade em nome do Jarvis (abre o aviso do macOS na primeira vez)
  if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true)
  buildTray()
  if (!(await ensureServer())) {
    dialog.showErrorBox('Jarvis', `O servidor não respondeu em ${BASE}. Confira o projeto em ${PROJETO}.`)
  }
  fetch(`${BASE}/api/app/ping`, { method: 'POST' }).catch(() => {})
  createHud(await openedAtLogin())
  createOverlays()
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, () => setTimeout(createOverlays, 400))
  globalShortcut.register('Alt+Space', toggleHud)
  // a procura automática de versão nova fica com o HUD (aviso discreto); aqui só pelo menu
})

app.on('activate', showHud)
app.on('before-quit', () => {
  quitting = true
  server?.kill()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', (e) => e.preventDefault())
