// Tela do launcher: entra, mostra o estado do Jarvis (instalar / atualizar / abrir), o Telegram e a versão.
const { invoke } = window.__TAURI__.core
const { listen } = window.__TAURI__.event
const $ = (id) => document.getElementById(id)
const mostrar = (id) => {
  for (const t of document.querySelectorAll('.tela')) t.hidden = t.id !== id
}
const mb = (b) => `${(b / 1e6).toFixed(b > 1e8 ? 0 : 1).replace('.', ',')} MB`
let local = null
let remoto = null
let ocupado = false

async function iniciar() {
  local = await invoke('estado_local')
  $('rodape').textContent = `launcher ${local.launcher} · ${({ mac: 'Mac', windows: 'Windows', linux: 'Linux' })[local.sistema]}`
  if (!local.logado) return mostrar('entrar')
  mostrar('principal')
  $('ola').textContent = `Olá, ${local.conta.nome.split(' ')[0]}`
  await atualizarRemoto()
}

async function atualizarRemoto() {
  try {
    remoto = await invoke('estado_remoto')
  } catch (e) {
    remoto = null
    const msg = String(e)
    if (msg.includes('pausada') || msg.includes('401') || msg.includes('não conferem')) {
      await invoke('sair')
      $('erro-entrar').textContent = msg.includes('pausada') ? msg : 'Entre de novo com a sua conta.'
      return mostrar('entrar')
    }
    $('jarvis-estado').textContent = msg
  }
  local = await invoke('estado_local')
  desenhar()
}

function desenhar() {
  const v = local.jarvis.versao
  const nova = remoto && remoto.jarvis
  const instalar = $('instalar')
  $('erro-jarvis').textContent = ''
  if (!nova) {
    $('jarvis-estado').textContent = v ? `Versão ${v} instalada.` : 'Ainda não há versão do Jarvis para este sistema.'
    instalar.hidden = true
  } else if (!local.jarvis.instalado) {
    $('jarvis-estado').textContent = `Versão ${nova.versao} pronta para instalar (${mb(nova.tamanho)}).`
    instalar.textContent = 'Instalar'
    instalar.hidden = false
  } else if (v !== nova.versao) {
    $('jarvis-estado').textContent = v ? `Atualização disponível: ${v} → ${nova.versao}.` : `Versão ${nova.versao} disponível (o Jarvis instalado não veio pelo launcher).`
    instalar.textContent = 'Atualizar'
    instalar.hidden = false
  } else {
    $('jarvis-estado').textContent = `Versão ${v}, a mais nova.`
    instalar.hidden = true
  }
  $('jarvis-notas').textContent = nova && v !== nova.versao && nova.notas ? nova.notas : ''
  $('abrir').hidden = !local.jarvis.instalado
  const tg = remoto && remoto.telegram
  if (!tg || !tg.robo) {
    $('tg-estado').textContent = 'O robô do Telegram ainda não foi configurado pelo administrador.'
    $('tg-abrir').hidden = true
  } else if (tg.ligado) {
    $('tg-estado').textContent = `Ligado. Fale com @${tg.robo} quando quiser.`
    $('tg-abrir').hidden = true
  } else {
    $('tg-estado').textContent = `Abra @${tg.robo} no Telegram com o seu código: a conversa fica ligada à sua conta.`
    $('tg-abrir').hidden = !tg.link
    $('tg-abrir').onclick = () => invoke('abrir_link', { url: tg.link })
  }
  const l = remoto && remoto.launcher
  $('aviso-launcher').hidden = !(l && l.versao !== local.launcher)
}

$('form-entrar').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('erro-entrar').textContent = ''
  const b = e.submitter
  b.disabled = true
  try {
    await invoke('entrar', { email: $('email').value, senha: $('senha').value })
    $('senha').value = ''
    await iniciar()
  } catch (err) {
    $('erro-entrar').textContent = String(err)
  } finally {
    b.disabled = false
  }
})

$('sair').onclick = async () => {
  await invoke('sair')
  mostrar('entrar')
}

$('instalar').onclick = async () => {
  if (ocupado) return
  ocupado = true
  $('instalar').disabled = true
  $('progresso').hidden = false
  $('erro-jarvis').textContent = ''
  try {
    await invoke('instalar')
    $('progresso-texto').textContent = 'Pronto. O Jarvis está abrindo.'
  } catch (e) {
    $('erro-jarvis').textContent = String(e)
  } finally {
    ocupado = false
    $('instalar').disabled = false
    setTimeout(() => ($('progresso').hidden = true), 2500)
    await atualizarRemoto()
  }
}

$('abrir').onclick = () => invoke('abrir_jarvis').catch((e) => ($('erro-jarvis').textContent = String(e)))

$('atualizar-launcher').onclick = async () => {
  $('atualizar-launcher').disabled = true
  try {
    await invoke('atualizar_launcher')
  } catch (e) {
    $('atualizar-launcher').disabled = false
    alert(String(e))
  }
}

listen('progresso', ({ payload: p }) => {
  const pct = p.total ? Math.min(100, (p.feito / p.total) * 100) : 0
  $('barra').style.width = `${p.fase === 'pronto' ? 100 : pct}%`
  $('progresso-texto').textContent = p.fase === 'baixando' ? `${p.texto} · ${mb(p.feito)} de ${mb(p.total)}` : p.texto
})

// confere de novo a cada 30 minutos (atualização nova aparece sozinha)
setInterval(() => !ocupado && local && local.logado && atualizarRemoto(), 30 * 60 * 1000)
iniciar()
