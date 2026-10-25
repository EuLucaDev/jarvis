// Mapa da memória (/memoria), estilo Obsidian: a pessoa no centro, os temas em volta e as memórias ligadas aos
// temas e entre si. Arrastar move o mapa, roda/pinça aproxima, clicar num ponto abre o que o Jarvis sabe dele.
// "Jarvis, mostre minha memória (sobre X)" abre esta janela; o app chama window.jarvisFoco(X) se já estiver aberta.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force'
import { Brain, FolderOpen, Link2, Plus, RefreshCw, Search, Sparkles, Trash2, Unlink, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import './memoria.css'

type Grupo = 'eu' | 'tema' | 'memoria'
type No = SimulationNodeDatum & { id: string; grupo: Grupo; rotulo: string; texto?: string; tipo?: string; fonte?: string; atualizada?: number; usos?: number }
type Lig = SimulationLinkDatum<No> & { a: string; b: string; rotulo: string; peso: number }
type Mapa = { nodes: No[]; links: { a: string; b: string; rotulo: string; peso: number }[] }
type Hit = { id: string; texto: string; temas: string[]; via?: string }

const TIPO_MEM: Record<string, { nome: string; cor: string }> = {
  perfil: { nome: 'Sobre você', cor: '#5fd4ff' },
  preferencia: { nome: 'Preferência', cor: '#7cf29a' },
  correcao: { nome: 'Correção', cor: '#ff8a7a' },
  licao: { nome: 'Lição', cor: '#ffd36b' },
  nota: { nome: 'Nota', cor: '#b9a7ff' },
}
const COR_TEMA = '#3fd3e8'
const raio = (n: No, grau: number) => (n.grupo === 'eu' ? 22 : n.grupo === 'tema' ? 9 + Math.min(10, Math.sqrt(grau) * 2.4) : 4.2)

export function Memoria() {
  const [mapa, setMapa] = useState<Mapa>({ nodes: [], links: [] })
  const [sel, setSel] = useState<string | null>(null)
  const [busca, setBusca] = useState(() => new URLSearchParams(location.search).get('foco') ?? '')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [ocupado, setOcupado] = useState(false)
  const cv = useRef<HTMLCanvasElement>(null)
  const sim = useRef<Simulation<No, Lig> | null>(null)
  const nodes = useRef<No[]>([])
  const links = useRef<Lig[]>([])
  const view = useRef({ x: 0, y: 0, k: 1 })
  const hover = useRef<string | null>(null)
  const destaque = useRef<Set<string>>(new Set())
  const selRef = useRef<string | null>(null)
  selRef.current = sel

  const carregar = useCallback(async () => {
    try {
      setMapa(await api<Mapa>('/api/memoria/mapa'))
    } catch {
      setAviso('Não consegui ler a memória agora.')
    }
  }, [])
  useEffect(() => {
    carregar()
    const t = setInterval(() => document.visibilityState === 'visible' && carregar(), 15000)
    return () => clearInterval(t)
  }, [carregar])

  // grau de cada nó (para o tamanho dos temas) e vizinhos (para destacar)
  const { grau, viz } = useMemo(() => {
    const grau: Record<string, number> = {}
    const viz: Record<string, Set<string>> = {}
    for (const l of mapa.links) {
      grau[l.a] = (grau[l.a] ?? 0) + 1
      grau[l.b] = (grau[l.b] ?? 0) + 1
      ;(viz[l.a] ??= new Set()).add(l.b)
      ;(viz[l.b] ??= new Set()).add(l.a)
    }
    return { grau, viz }
  }, [mapa])
  const grauRef = useRef(grau)
  grauRef.current = grau
  const vizRef = useRef(viz)
  vizRef.current = viz

  // simulação: mantém as posições de quem já estava na tela; a pessoa fica presa no centro
  useEffect(() => {
    const antes = new Map(nodes.current.map((n) => [n.id, n]))
    const ns: No[] = mapa.nodes.map((n) => {
      const o = antes.get(n.id)
      return o ? Object.assign(o, n) : { ...n, x: (Math.random() - 0.5) * 300, y: (Math.random() - 0.5) * 300 }
    })
    const eu = ns.find((n) => n.grupo === 'eu')
    if (eu) {
      eu.fx = 0
      eu.fy = 0
    }
    const ids = new Set(ns.map((n) => n.id))
    const ls: Lig[] = mapa.links.filter((l) => ids.has(l.a) && ids.has(l.b)).map((l) => ({ ...l, source: l.a, target: l.b }))
    nodes.current = ns
    links.current = ls
    sim.current?.stop()
    sim.current = forceSimulation<No, Lig>(ns)
      .force(
        'link',
        forceLink<No, Lig>(ls)
          .id((n) => n.id)
          .distance((l) => (l.rotulo === 'parte de' ? 120 : l.rotulo === 'sobre' ? 46 : 60))
          .strength((l) => (l.rotulo === 'relacionado' ? 0.15 * l.peso : 0.7)),
      )
      .force('charge', forceManyBody<No>().strength((n) => (n.grupo === 'memoria' ? -40 : -340)))
      .force('collide', forceCollide<No>((n) => raio(n, grauRef.current[n.id] ?? 0) + 4))
      .force('x', forceX(0).strength(0.03))
      .force('y', forceY(0).strength(0.03))
      .alpha(antes.size ? 0.4 : 1)
    return () => {
      sim.current?.stop()
    }
  }, [mapa])

  // desenho (um quadro por vez, sem React)
  useEffect(() => {
    const c = cv.current!
    const ctx = c.getContext('2d')!
    let raf = 0
    const draw = () => {
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = c.clientWidth
      const h = c.clientHeight
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      const { x: vx, y: vy, k } = view.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      ctx.translate(w / 2 + vx, h / 2 + vy)
      ctx.scale(k, k)
      const foco = hover.current ?? selRef.current
      const perto = foco ? new Set([foco, ...(vizRef.current[foco] ?? [])]) : null
      const marc = destaque.current
      const apagado = (id: string) => (perto && !perto.has(id)) || (marc.size > 0 && !marc.has(id) && !perto)
      for (const l of links.current) {
        const s = l.source as No
        const t = l.target as No
        if (s.x == null || t.x == null) continue
        const on = perto ? perto.has(s.id) && perto.has(t.id) && (s.id === foco || t.id === foco) : marc.size ? marc.has(s.id) && marc.has(t.id) : false
        ctx.strokeStyle = on ? 'rgb(95 212 255 / 0.85)' : l.rotulo === 'relacionado' ? 'rgb(185 167 255 / 0.16)' : 'rgb(95 212 255 / 0.16)'
        ctx.lineWidth = (on ? 1.6 : l.rotulo === 'parte de' ? 1.3 : 0.8) / Math.sqrt(k)
        if (l.rotulo === 'relacionado') ctx.setLineDash([3 / k, 3 / k])
        ctx.beginPath()
        ctx.moveTo(s.x, s.y!)
        ctx.lineTo(t.x, t.y!)
        ctx.stroke()
        ctx.setLineDash([])
      }
      for (const n of nodes.current) {
        if (n.x == null) continue
        const r = raio(n, grauRef.current[n.id] ?? 0)
        const cor = n.grupo === 'memoria' ? TIPO_MEM[n.tipo ?? 'nota']?.cor ?? '#b9a7ff' : n.grupo === 'tema' ? COR_TEMA : '#e8f4ff'
        ctx.globalAlpha = apagado(n.id) ? 0.18 : 1
        if (n.grupo !== 'memoria' || n.id === foco || marc.has(n.id)) {
          ctx.shadowColor = cor
          ctx.shadowBlur = n.grupo === 'eu' ? 30 : 14
        }
        ctx.fillStyle = n.grupo === 'tema' ? 'rgb(6 22 48)' : cor
        ctx.beginPath()
        ctx.arc(n.x, n.y!, r, 0, Math.PI * 2)
        ctx.fill()
        if (n.grupo !== 'memoria') {
          ctx.strokeStyle = cor
          ctx.lineWidth = n.grupo === 'eu' ? 2.5 : 1.8
          ctx.stroke()
        }
        if (n.id === selRef.current) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5 / k
          ctx.beginPath()
          ctx.arc(n.x, n.y!, r + 4 / k, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
        const mostra = n.grupo !== 'memoria' || n.id === foco || marc.has(n.id) || (perto?.has(n.id) && k > 0.8) || k > 1.9
        if (mostra) {
          const fs = n.grupo === 'eu' ? 15 : n.grupo === 'tema' ? 12 : 10.5
          ctx.font = `${n.grupo === 'memoria' ? 500 : 600} ${fs / Math.max(0.85, Math.sqrt(k))}px Manrope, system-ui, sans-serif`
          ctx.textAlign = 'center'
          ctx.fillStyle = n.grupo === 'memoria' ? 'rgb(214 230 245 / 0.9)' : '#e8f4ff'
          const txt = n.grupo === 'memoria' && n.rotulo.length >= 48 ? n.rotulo + '…' : n.rotulo
          ctx.fillText(txt, n.x, n.y! + r + 13 / Math.sqrt(k))
        }
        ctx.globalAlpha = 1
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ---------- mouse: arrastar o mapa ou um ponto, roda aproxima, clique seleciona ----------
  const toWorld = (cx: number, cy: number) => {
    const c = cv.current!.getBoundingClientRect()
    const { x, y, k } = view.current
    return { x: (cx - c.left - c.width / 2 - x) / k, y: (cy - c.top - c.height / 2 - y) / k }
  }
  const nodeAt = (cx: number, cy: number) => {
    const p = toWorld(cx, cy)
    let best: No | null = null
    let bd = Infinity
    for (const n of nodes.current) {
      if (n.x == null) continue
      const d = Math.hypot(n.x - p.x, n.y! - p.y)
      const r = raio(n, grau[n.id] ?? 0) + 6 / view.current.k
      if (d < r && d < bd) {
        best = n
        bd = d
      }
    }
    return best
  }
  const drag = useRef<{ kind: 'mapa' | 'no'; n?: No; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const onDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    const n = nodeAt(e.clientX, e.clientY)
    drag.current = n
      ? { kind: 'no', n, sx: e.clientX, sy: e.clientY, ox: 0, oy: 0, moved: false }
      : { kind: 'mapa', sx: e.clientX, sy: e.clientY, ox: view.current.x, oy: view.current.y, moved: false }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) {
      const n = nodeAt(e.clientX, e.clientY)
      hover.current = n?.id ?? null
      cv.current!.style.cursor = n ? 'pointer' : 'grab'
      return
    }
    if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true
    if (d.kind === 'mapa') {
      view.current.x = d.ox + e.clientX - d.sx
      view.current.y = d.oy + e.clientY - d.sy
    } else if (d.n && d.moved && d.n.grupo !== 'eu') {
      const p = toWorld(e.clientX, e.clientY)
      d.n.fx = p.x
      d.n.fy = p.y
      sim.current?.alphaTarget(0.2).restart()
    }
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.kind === 'no' && d.n) {
      if (d.n.grupo !== 'eu') {
        d.n.fx = null
        d.n.fy = null
      }
      sim.current?.alphaTarget(0)
      if (!d.moved) setSel(d.n.id)
    } else if (!d.moved) setSel(null)
  }
  const onWheel = (e: React.WheelEvent) => {
    const c = cv.current!.getBoundingClientRect()
    const v = view.current
    const k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0015)))
    const mx = e.clientX - c.left - c.width / 2
    const my = e.clientY - c.top - c.height / 2
    v.x = mx - ((mx - v.x) * k) / v.k
    v.y = my - ((my - v.y) * k) / v.k
    v.k = k
  }
  const centrar = (id: string) => {
    const n = nodes.current.find((x) => x.id === id)
    if (!n || n.x == null) return
    const v = view.current
    v.k = Math.max(v.k, 1.1)
    v.x = -n.x * v.k
    v.y = -n.y! * v.k
  }

  // ---------- busca (segue as ligações) e foco pedido por voz ----------
  const buscar = useCallback(
    async (q: string) => {
      const t = q.trim()
      if (!t) {
        setHits(null)
        destaque.current = new Set()
        return
      }
      const tema = mapa.nodes.find((n) => n.grupo === 'tema' && n.rotulo.toLowerCase() === t.toLowerCase())
      try {
        const r = await api<Hit[]>(`/api/memoria/buscar?q=${encodeURIComponent(t)}`)
        setHits(r)
        const ids = new Set(r.map((h) => h.id))
        for (const h of r) for (const nome of h.temas) mapa.nodes.filter((n) => n.grupo === 'tema' && n.rotulo === nome).forEach((n) => ids.add(n.id))
        if (tema) ids.add(tema.id)
        destaque.current = ids
        if (tema) {
          setSel(tema.id)
          centrar(tema.id)
        } else if (r[0]) centrar(r[0].id)
      } catch {
        setAviso('A busca falhou agora.')
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mapa],
  )
  const primeiraBusca = useRef(true)
  useEffect(() => {
    if (primeiraBusca.current && mapa.nodes.length && busca) {
      primeiraBusca.current = false
      setTimeout(() => buscar(busca), 900) // espera o mapa assentar
    }
  }, [mapa, busca, buscar])
  useEffect(() => {
    ;(window as unknown as { jarvisFoco?: (f: string) => void }).jarvisFoco = (f: string) => {
      setBusca(f)
      carregar().then(() => buscar(f))
    }
  }, [buscar, carregar])

  // ---------- ações ----------
  const no = sel ? mapa.nodes.find((n) => n.id === sel) ?? null : null
  const vizinhos = sel ? [...(viz[sel] ?? [])].map((id) => mapa.nodes.find((n) => n.id === id)).filter(Boolean) as No[] : []
  const temas = mapa.nodes.filter((n) => n.grupo === 'tema')
  const mems = mapa.nodes.filter((n) => n.grupo === 'memoria')

  const acao = async (fn: () => Promise<unknown>, ok?: string) => {
    setOcupado(true)
    try {
      await fn()
      if (ok) setAviso(ok)
      await carregar()
    } catch (e) {
      setAviso(String((e as Error).message || e).slice(0, 160))
    } finally {
      setOcupado(false)
    }
  }
  const [novo, setNovo] = useState<{ texto: string; tema: string } | null>(null)

  return (
    <div className="memmap">
      <header className="mem-top">
        <div className="mem-brand">
          <Brain size={18} />
          <div>
            <b>Memória</b>
            <small>
              {temas.length} temas · {mems.length} memórias
            </small>
          </div>
        </div>
        <form
          className="mem-search"
          onSubmit={(e) => {
            e.preventDefault()
            buscar(busca)
          }}
        >
          <Search size={14} />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar no que o Jarvis sabe (segue as ligações)" />
          {busca && (
            <button type="button" aria-label="Limpar busca" onClick={() => (setBusca(''), buscar(''))}>
              <X size={13} />
            </button>
          )}
        </form>
        <div className="mem-actions">
          <button onClick={() => setNovo({ texto: '', tema: '' })}>
            <Plus size={14} /> Nova memória
          </button>
          <button disabled={ocupado} onClick={() => acao(async () => setAviso(`${(await api('/api/memoria/organizar', { method: 'POST' })).ligadas} ligações novas`))}>
            <Sparkles size={14} /> Organizar
          </button>
          <button onClick={() => acao(() => api('/api/memoria/pasta', { method: 'POST' }))} title="Uma nota por tema, com [[ligações]]: abre como cofre no Obsidian">
            <FolderOpen size={14} /> Abrir como notas
          </button>
          <button aria-label="Atualizar" onClick={() => carregar()}>
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <canvas ref={cv} className="mem-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => (hover.current = null)} onWheel={onWheel} />

      {!mems.length && (
        <div className="mem-empty">
          <Brain size={28} />
          <b>A memória ainda está vazia</b>
          <p>Converse com o Jarvis: ele guarda o que for importante sobre você e liga cada coisa aos temas. Também dá para dizer “Jarvis, lembre que…”.</p>
        </div>
      )}

      <div className="mem-legend" aria-hidden="true">
        <span>
          <i className="eu" /> Você
        </span>
        <span>
          <i className="tema" /> Tema
        </span>
        {Object.entries(TIPO_MEM).map(([k, v]) => (
          <span key={k}>
            <i style={{ background: v.cor }} /> {v.nome}
          </span>
        ))}
        <span>
          <i className="rel" /> Parecidas
        </span>
      </div>

      {hits && (
        <aside className="mem-hits">
          <header>
            <b>{hits.length ? `${hits.length} encontradas` : 'Nada encontrado'}</b>
            <button aria-label="Fechar" onClick={() => (setHits(null), (destaque.current = new Set()))}>
              <X size={13} />
            </button>
          </header>
          {hits.map((h) => (
            <button key={h.id} onClick={() => (setSel(h.id), centrar(h.id))}>
              <span>{h.texto}</span>
              <small>
                {h.temas.join(' · ') || 'sem tema'}
                {h.via && h.via !== h.temas[0] ? ` · veio por ${h.via}` : ''}
              </small>
            </button>
          ))}
        </aside>
      )}

      {no && (
        <Detalhe
          key={no.id}
          no={no}
          vizinhos={vizinhos}
          temas={temas}
          ocupado={ocupado}
          onIr={(id) => (setSel(id), centrar(id))}
          onClose={() => setSel(null)}
          acao={acao}
        />
      )}

      {novo && (
        <div className="mem-modal" role="dialog" aria-label="Nova memória">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!novo.texto.trim()) return
              acao(() => api('/api/memorias', { method: 'POST', json: { tipo: 'nota', texto: novo.texto, temas: novo.tema ? [novo.tema] : [] } }), 'Memória guardada').then(() => setNovo(null))
            }}
          >
            <b>Nova memória</b>
            <textarea autoFocus value={novo.texto} onChange={(e) => setNovo({ ...novo, texto: e.target.value })} placeholder="Ex.: Prefere reuniões depois das 10h." rows={3} />
            <input list="mem-temas" value={novo.tema} onChange={(e) => setNovo({ ...novo, tema: e.target.value })} placeholder="Tema (opcional: o Jarvis escolhe sozinho)" />
            <datalist id="mem-temas">
              {temas.map((t) => (
                <option key={t.id} value={t.rotulo} />
              ))}
            </datalist>
            <footer>
              <button type="button" onClick={() => setNovo(null)}>
                Cancelar
              </button>
              <button type="submit" className="primary" disabled={ocupado}>
                Guardar
              </button>
            </footer>
          </form>
        </div>
      )}

      {aviso && (
        <div className="mem-toast" onAnimationEnd={() => setAviso(null)}>
          {aviso}
        </div>
      )}
    </div>
  )
}

function Detalhe({
  no,
  vizinhos,
  temas,
  ocupado,
  onIr,
  onClose,
  acao,
}: {
  no: No
  vizinhos: No[]
  temas: No[]
  ocupado: boolean
  onIr: (id: string) => void
  onClose: () => void
  acao: (fn: () => Promise<unknown>, ok?: string) => Promise<void>
}) {
  const [texto, setTexto] = useState(no.texto ?? '')
  const [tema, setTema] = useState('')
  const seusTemas = vizinhos.filter((v) => v.grupo === 'tema' || v.grupo === 'eu')
  const memorias = vizinhos.filter((v) => v.grupo === 'memoria')
  const ligarTema = async () => {
    const nome = tema.trim()
    if (!nome) return
    const existente = temas.find((t) => t.rotulo.toLowerCase() === nome.toLowerCase())
    const id = existente?.id ?? (await api<{ id: string }>('/api/memoria/temas', { method: 'POST', json: { nome } })).id
    await api('/api/memoria/ligar', { method: 'POST', json: { a: no.id, b: id } })
    setTema('')
  }
  const titulo = no.grupo === 'eu' ? no.rotulo : no.grupo === 'tema' ? no.rotulo : TIPO_MEM[no.tipo ?? 'nota']?.nome ?? 'Memória'
  return (
    <aside className="mem-side">
      <header>
        <span className={`mem-kind ${no.grupo}`} style={no.grupo === 'memoria' ? { color: TIPO_MEM[no.tipo ?? 'nota']?.cor } : undefined}>
          {no.grupo === 'eu' ? 'Centro' : no.grupo === 'tema' ? `Tema · ${no.tipo}` : titulo}
        </span>
        <button aria-label="Fechar" onClick={onClose}>
          <X size={14} />
        </button>
      </header>

      {no.grupo === 'memoria' ? (
        <>
          <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={4} />
          <div className="mem-row">
            <small>
              {no.fonte === 'reflexao' ? 'Aprendida numa conversa' : no.fonte === 'pedido' ? 'Você pediu para lembrar' : 'Escrita no painel'}
              {no.atualizada ? ` · ${new Date(no.atualizada * 1000).toLocaleDateString('pt-BR')}` : ''}
              {no.usos ? ` · usada ${no.usos}×` : ''}
            </small>
            {texto.trim() !== (no.texto ?? '') && (
              <button className="primary" disabled={ocupado} onClick={() => acao(() => api(`/api/memorias/${no.id}`, { method: 'PATCH', json: { texto } }), 'Memória atualizada')}>
                Salvar
              </button>
            )}
          </div>
        </>
      ) : (
        <h2>{titulo}</h2>
      )}

      {no.grupo === 'memoria' && (
        <section>
          <h3>Temas</h3>
          <div className="mem-chips">
            {seusTemas.map((t) => (
              <span key={t.id} className="mem-chip">
                <button onClick={() => onIr(t.id)}>{t.rotulo}</button>
                <button aria-label={`Tirar do tema ${t.rotulo}`} onClick={() => acao(() => api('/api/memoria/ligar', { method: 'POST', json: { a: no.id, b: t.id, desligar: true } }))}>
                  <Unlink size={11} />
                </button>
              </span>
            ))}
          </div>
          <form
            className="mem-addtema"
            onSubmit={(e) => {
              e.preventDefault()
              acao(ligarTema)
            }}
          >
            <input list="mem-temas-side" value={tema} onChange={(e) => setTema(e.target.value)} placeholder="Ligar a um tema" />
            <datalist id="mem-temas-side">
              {temas.map((t) => (
                <option key={t.id} value={t.rotulo} />
              ))}
            </datalist>
            <button type="submit" aria-label="Ligar" disabled={!tema.trim() || ocupado}>
              <Link2 size={13} />
            </button>
          </form>
        </section>
      )}

      {no.grupo !== 'memoria' && seusTemas.length > 0 && (
        <section>
          <h3>{no.grupo === 'eu' ? 'Temas' : 'Ligado a'}</h3>
          <div className="mem-chips">
            {seusTemas.map((t) => (
              <span key={t.id} className="mem-chip">
                <button onClick={() => onIr(t.id)}>{t.rotulo}</button>
              </span>
            ))}
          </div>
        </section>
      )}

      {memorias.length > 0 && (
        <section className="mem-list">
          <h3>{no.grupo === 'memoria' ? 'Memórias ligadas' : `O que o Jarvis sabe (${memorias.length})`}</h3>
          {memorias.map((m) => (
            <button key={m.id} onClick={() => onIr(m.id)}>
              <i style={{ background: TIPO_MEM[m.tipo ?? 'nota']?.cor }} />
              {m.texto}
            </button>
          ))}
        </section>
      )}

      {no.grupo !== 'eu' && (
        <footer>
          <button
            className="danger"
            disabled={ocupado}
            onClick={() =>
              acao(
                () => api(no.grupo === 'tema' ? `/api/memoria/temas/${encodeURIComponent(no.id)}` : `/api/memorias/${no.id}`, { method: 'DELETE' }),
                no.grupo === 'tema' ? 'Tema apagado (as memórias continuam)' : 'Memória apagada',
              ).then(onClose)
            }
          >
            <Trash2 size={13} /> {no.grupo === 'tema' ? 'Apagar tema' : 'Esquecer'}
          </button>
        </footer>
      )}
    </aside>
  )
}
