// Estado de uma tela do Jarvis (HUD, camada ou painel), montado a partir dos eventos do núcleo.
// A voz, a câmera e as mãos rodam no núcleo; aqui só chega o que mostrar.

import { useCallback, useEffect, useRef, useState } from 'react'
import { play } from '../lib/sfx'
import { JarvisSocket, type Alert, type Card, type ServerEvent, type Task, type Telemetry, type VoiceStatus } from '../lib/socket'

export type LogLine = { quem: 'voce' | 'jarvis'; texto: string }

// frase de etapa enquanto uma ferramenta trabalha ("Pesquisando na web…")
const STEP: Record<string, string> = {
  pesquisar_web: 'Pesquisando na web',
  mostrar_pesquisa: 'Montando o cartão',
  consultar_clima: 'Consultando o clima',
  briefing_bom_dia: 'Mostrando suas prioridades',
  buscar_memorias: 'Consultando a memória',
  lembrar: 'Anotando',
  mostrar_memoria: 'Abrindo sua memória',
  controlar_janela: 'Mexendo na janela',
  financeiro_lancar: 'Lançando',
  financeiro_consultar: 'Olhando suas finanças',
  financeiro_importar: 'Lendo os extratos',
  financeiro_pagar: 'Pagando',
  financeiro_meta: 'Mexendo na meta',
  espelhar_tela: 'Olhando sua tela',
  consultar_mercado: 'Lendo o mercado',
  ler_mensagens: 'Lendo suas mensagens',
  notas: 'Procurando nas notas',
  consultar_saude: 'Lendo seus dados de saúde',
  ver_camera: 'Abrindo a câmera',
  executar_protocolo: 'Executando o protocolo',
  delegar_tarefa: 'Passando a tarefa adiante',
  abrir_painel: 'Abrindo o painel',
  arquivos: 'Mexendo nos arquivos',
  contexto_atual: 'Olhando o que você está fazendo',
  olhar: 'Olhando',
  substituir_selecao: 'Trocando o texto',
  clicar: 'Clicando',
  digitar: 'Escrevendo',
  teclas: 'Usando o teclado',
  navegador: 'Mexendo no navegador',
  mostrar_plano: 'Montando o plano',
  onde_parei: 'Lembrando onde você parou',
  camera: 'Mexendo na câmera',
}

function lastWords(text: string, n: number) {
  const words = text.trim().split(/\s+/)
  // legenda em blocos: troca o bloco inteiro a cada n palavras
  const start = Math.max(0, Math.floor((words.length - 1) / n) * n)
  return words.slice(start, start + n).join(' ')
}

export function useJarvis(role: 'hud' | 'overlay' | 'admin' = 'hud') {
  const [online, setOnline] = useState(false)
  const [status, setStatus] = useState<VoiceStatus>({ voice: 'off' })
  const [cards, setCards] = useState<Card[]>([])
  const [caption, setCaption] = useState('')
  const [userLine, setUserLine] = useState('')
  const [log, setLog] = useState<LogLine[]>([])
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [step, setStep] = useState<string | null>(null)
  const [panel, setPanel] = useState<string | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [suggestions, setSuggestions] = useState<{ id: string; texto: string; pedido: string }[]>([])
  const [focusUntil, setFocusUntil] = useState(0)
  const [stoppedAt, setStoppedAt] = useState(0)
  const [camera, setCamera] = useState<{ ligada: boolean; erro?: string }>({ ligada: false })
  const [tela, setTela] = useState<{ ligada: boolean; erro?: string }>({ ligada: false })
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null)
  const [last, setLast] = useState<ServerEvent | null>(null) // eventos que cada tela trata do seu jeito (olhar, gesto, janela…)

  const sock = useRef<JarvisSocket | null>(null)
  const modelBuf = useRef('')
  const userNew = useRef(true)
  const sound = role === 'hud' // só uma janela toca os efeitos
  const sfx = useCallback((k: Parameters<typeof play>[0], pan = 0) => sound && play(k, pan), [sound])

  const pushLog = useCallback((quem: LogLine['quem'], texto: string, novo: boolean) => {
    setLog((l) => {
      const ult = l.at(-1)
      if (!novo && ult && ult.quem === quem) return [...l.slice(0, -1), { quem, texto: (ult.texto + texto).slice(-600) }]
      return [...l, { quem, texto }].slice(-30)
    })
  }, [])

  const onEvent = useCallback(
    (e: ServerEvent) => {
      switch (e.type) {
        case 'sync':
          setCards(e.cards)
          setStatus(e.status)
          if (e.tarefas) setTasks(e.tarefas)
          break
        case 'status':
          setStatus((prev) => {
            if (e.voice === 'live' && prev.voice !== 'live') sfx('listen')
            if (e.voice === 'error' && prev.voice !== 'error') sfx('error')
            return { voice: e.voice, model: e.model, error: e.error }
          })
          if (e.voice !== 'live') setStep(null)
          break
        case 'user.text': {
          const novo = !!e.typed || !!e.novo || userNew.current
          userNew.current = false
          modelBuf.current = ''
          setUserLine((s) => (novo ? e.text : s + e.text).slice(-160))
          pushLog('voce', e.text, novo)
          break
        }
        case 'legenda': {
          const novo = modelBuf.current === ''
          modelBuf.current += e.texto
          userNew.current = true
          setStep(null)
          setCaption(lastWords(modelBuf.current, 8))
          pushLog('jarvis', e.texto, novo)
          break
        }
        case 'tool':
          if (e.phase === 'start') {
            setStep(STEP[e.name] ?? 'Trabalhando nisso')
            sfx(e.name === 'briefing_bom_dia' ? 'start' : 'step')
          }
          break
        case 'card':
          setCards((c) => [...c.filter((x) => x.id !== e.card.id), e.card].slice(-8))
          if (e.card.kind !== 'carregando') sfx('card')
          break
        case 'card.update':
          setCards((c) => c.map((x) => (x.id === e.card.id ? e.card : x)))
          break
        case 'card.close':
          setCards((c) => c.filter((x) => x.id !== e.id))
          break
        case 'cards.clear':
          setCards((c) => {
            if (c.length) sfx('close')
            return []
          })
          break
        case 'alerta': {
          const { type: _t, ...a } = e
          setAlerts((l) => [...l.filter((x) => x.id !== a.id), a].slice(-4))
          if (!a.silencioso) sfx('alert', 0.6)
          setTimeout(() => setAlerts((l) => l.filter((x) => x.id !== a.id)), 14000)
          break
        }
        case 'telemetria':
          setTelemetry(e)
          break
        case 'painel':
          setPanel(e.visao || null)
          break
        case 'tarefa':
          setTasks((l) => [e.tarefa, ...l.filter((x) => x.id !== e.tarefa.id)].slice(0, 12))
          if (e.tarefa.estado !== 'rodando') sfx(e.tarefa.estado === 'feito' ? 'alert' : 'error')
          break
        case 'sugestao':
          setSuggestions((l) => [{ id: e.id, texto: e.texto, pedido: e.pedido }, ...l].slice(0, 3))
          sfx('step', 0.7)
          break
        case 'parado':
          setStoppedAt(Date.now())
          setStep(null)
          sfx('close')
          break
        case 'foco':
          setFocusUntil(e.ate ? e.ate * 1000 : 0)
          break
        case 'camera':
          setCamera({ ligada: e.ligada, erro: e.erro })
          break
        case 'tela':
          setTela({ ligada: e.ligada, erro: e.erro })
          break
        case 'despertar':
          sfx('unlock')
          setLast(e)
          break
        default:
          setLast(e)
      }
    },
    [pushLog, sfx],
  )

  useEffect(() => {
    const s = new JarvisSocket(role, { onEvent, onOpen: setOnline })
    sock.current = s
    return () => s.close()
  }, [role, onEvent])

  // a legenda some um tempo depois do fim da fala
  useEffect(() => {
    if (!caption) return
    const t = setTimeout(() => {
      setCaption('')
      modelBuf.current = ''
    }, 3600)
    return () => clearTimeout(t)
  }, [caption])

  const send = useCallback((msg: object) => sock.current?.send(msg), [])
  return {
    online,
    status,
    cards,
    caption,
    userLine,
    log,
    alerts,
    step,
    panel,
    setPanel,
    tasks,
    suggestions,
    focusUntil,
    stoppedAt,
    camera,
    tela,
    telemetry,
    last,
    send,
    ask: (text: string) => send({ type: 'text', text }),
    startVoice: () => send({ type: 'voice.start' }),
    stopVoice: () => send({ type: 'voice.stop' }),
    closeCard: (id: string) => send({ type: 'card.close', id }),
    clearCards: () => send({ type: 'cards.clear' }),
    dismissAlert: (id: string) => setAlerts((l) => l.filter((x) => x.id !== id)),
    dismissSuggestion: (id: string) => setSuggestions((l) => l.filter((x) => x.id !== id)),
  }
}

export type Jarvis = ReturnType<typeof useJarvis>
