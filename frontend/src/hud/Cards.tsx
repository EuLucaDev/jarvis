import {
  CalendarDays,
  Undo2,
  Wallet,
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  Workflow,
  XCircle,
  Camera,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  ExternalLink,
  HeartPulse,
  LineChart,
  MessageCircle,
  ListChecks,
  Loader2,
  Mail,
  Newspaper,
  Search,
  Sun,
  Umbrella,
  Wind,
  X,
} from 'lucide-react'
import type { Card } from '../lib/socket'
import { useState, type CSSProperties } from 'react'
import { api } from '../lib/api'

const num = (v: unknown, d = 1) =>
  typeof v === 'number' ? v.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'

const WEATHER_ICON = {
  sun: Sun,
  'cloud-sun': CloudSun,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  storm: CloudLightning,
} as const

function Head({ card, icon: Icon, onClose }: { card: Card; icon: typeof Search; onClose?: () => void }) {
  return (
    <header className="card-head">
      <span className="card-icon">
        <Icon size={16} strokeWidth={1.75} />
      </span>
      <div className="card-titles">
        <span className="card-cat">{card.data.categoria ?? labelFor(card.kind)}</span>
        <h2 className="card-title">{card.data.titulo ?? card.data.cidade}</h2>
      </div>
      {onClose && (
        <button className="card-close" onClick={onClose} aria-label="Fechar cartão">
          <X size={14} />
        </button>
      )}
    </header>
  )
}

function labelFor(kind: Card['kind']) {
  return {
    pesquisa: 'Pesquisa',
    clima: 'Clima · Agora',
    lista: 'Lista',
    emails: 'E-mails · Prioridade',
    agenda: 'Agenda',
    noticia: 'Notícias',
    carregando: 'Resumo executivo',
    camera: 'Câmera · Ao vivo',
    mercado: 'Mercado · Cotações',
    mensagens: 'Mensagens · iMessage',
    saude: 'Saúde · Apple',
    plano: 'Trabalhando junto',
    financeiro: 'Financeiro',
  }[kind]
}

function Pesquisa({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const itens: any[] = d.itens ?? []
  const fontes: any[] = d.fontes ?? []
  const lead = Math.max(...itens.map((i) => i.valor ?? 0), 0)
  return (
    <>
      <Head card={card} icon={Search} onClose={onClose} />
      {d.referencia && <p className="card-ref">{d.referencia}</p>}
      {itens.length > 0 && (
        <section className="card-block">
          {(d.grupo || d.progresso) && (
            <div className="row-meta">
              <span>{d.grupo}</span>
              {d.progresso && <span className="pill">{d.progresso}</span>}
            </div>
          )}
          <ul className="rank">
            {itens.slice(0, 5).map((it, i) => (
              <li key={i} className={it.valor === lead && lead > 0 ? 'is-lead' : ''}>
                <div className="rank-top">
                  <strong>{it.rotulo}</strong>
                  <span className="rank-val">{it.valor_texto ?? (it.valor != null ? `${num(it.valor, 0)}%` : '')}</span>
                </div>
                {typeof it.valor === 'number' && (
                  <div className="bar">
                    <span style={{ width: `${Math.max(2, Math.min(100, it.valor))}%` }} />
                  </div>
                )}
                {(it.detalhe || it.etiqueta) && (
                  <div className="rank-foot">
                    <span>{it.detalhe}</span>
                    {it.etiqueta && <span className="pill">{it.etiqueta}</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card-block summary">
        <span className="block-label">Em resumo</span>
        <p>{d.resumo}</p>
      </section>
      {d.pontos?.length > 0 && (
        <ul className="points">
          {d.pontos.slice(0, 4).map((p: string, i: number) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {fontes.length > 0 && (
        <ul className="sources">
          {fontes.slice(0, 3).map((f, i) => (
            <li key={i}>
              {f.url ? (
                <a href={f.url} target="_blank" rel="noreferrer">
                  {f.titulo} <ExternalLink size={11} />
                </a>
              ) : (
                f.titulo
              )}
            </li>
          ))}
        </ul>
      )}
      <footer className="card-foot">
        <span>{fontes.length ? `${fontes.length} ${fontes.length === 1 ? 'fonte' : 'fontes'}` : 'Sem fontes'}</span>
        <span>Consultado às {card.at}</span>
      </footer>
    </>
  )
}

function Clima({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const Icon = WEATHER_ICON[d.icone as keyof typeof WEATHER_ICON] ?? Cloud
  return (
    <>
      <Head card={{ ...card, data: { ...d, titulo: d.cidade, categoria: `Clima · ${d.regiao || 'Agora'}` } }} icon={Icon} onClose={onClose} />
      <div className="weather">
        <div className="weather-main">
          <Icon size={34} strokeWidth={1.4} className="weather-ico" />
          <span className="weather-temp">{num(d.temperatura)}°</span>
          <div className="weather-cond">
            <span>{d.condicao}</span>
            <span className="muted">
              Mín {num(d.minima)}° · Máx {num(d.maxima)}° · Sensação {num(d.sensacao)}°
            </span>
          </div>
        </div>
        <ul className="weather-stats">
          <li>
            <Umbrella size={14} /> <b>{d.chuva ?? '—'}%</b> chuva
          </li>
          <li>
            <Droplets size={14} /> <b>{d.umidade ?? '—'}%</b> umidade
          </li>
          <li>
            <Wind size={14} /> <b>{num(d.vento)}</b> km/h
          </li>
        </ul>
      </div>
      <footer className="card-foot">
        <span>Open-Meteo</span>
        <span>Atualizado às {card.at}</span>
      </footer>
    </>
  )
}

function Lista({ card, onClose }: { card: Card; onClose?: () => void }) {
  const itens: any[] = card.data.itens ?? []
  return (
    <>
      <Head card={card} icon={ListChecks} onClose={onClose} />
      <ol className="list">
        {itens.slice(0, 7).map((it, i) => (
          <li key={i}>
            <div>
              <strong>{it.titulo}</strong>
              {it.detalhe && <span className="muted">{it.detalhe}</span>}
            </div>
            {it.etiqueta && <span className="pill">{it.etiqueta}</span>}
          </li>
        ))}
      </ol>
      <footer className="card-foot">
        <span>{itens.length} itens</span>
        <span>{card.at}</span>
      </footer>
    </>
  )
}

const PASSO_ICONE = { pendente: Circle, fazendo: CircleDashed, feito: CheckCircle2, pulado: CircleSlash, erro: XCircle } as const

/** Plano de uma tarefa no Mac: cada passo é marcado enquanto o Jarvis trabalha. */
function Plano({ card, onClose }: { card: Card; onClose?: () => void }) {
  const passos: { texto: string; estado: keyof typeof PASSO_ICONE }[] = card.data.passos ?? []
  const feitos = passos.filter((p) => p.estado === 'feito').length
  return (
    <>
      <Head card={card} icon={Workflow} onClose={onClose} />
      <div className="plan-bar" aria-hidden="true">
        <span style={{ width: `${passos.length ? (feitos / passos.length) * 100 : 0}%` }} />
      </div>
      <ol className="plan">
        {passos.map((p, i) => {
          const Icon = PASSO_ICONE[p.estado] ?? Circle
          return (
            <li key={i} className={`st-${p.estado}`}>
              <Icon size={15} className={p.estado === 'fazendo' ? 'spin-slow' : ''} />
              <span>
                <i>{String(i + 1).padStart(2, '0')}</i> {p.texto}
              </span>
            </li>
          )
        })}
      </ol>
      <footer className="card-foot">
        <span>
          {feitos} de {passos.length} passos · Esc para parar
        </span>
        <span>{card.at}</span>
      </footer>
    </>
  )
}

/** Texto simples de um cartão, para copiar e colar em outro app. */
export function cardText(card: Card) {
  const d = card.data
  const linhas: string[] = []
  const titulo = d.titulo ?? d.cidade
  if (titulo) linhas.push(String(titulo))
  if (d.resumo) linhas.push('', d.resumo)
  if (card.kind === 'clima') linhas.push(`${d.temperatura}° · ${d.condicao} · mín ${d.minima}° máx ${d.maxima}° · chuva ${d.chuva}%`)
  for (const p of d.pontos ?? []) linhas.push(`• ${p}`)
  for (const it of d.itens ?? []) linhas.push(`• ${[it.rotulo ?? it.titulo, it.valor_texto ?? it.detalhe].filter(Boolean).join(' — ')}`)
  for (const a of d.ativos ?? []) linhas.push(`• ${a.nome}: ${a.preco} (${a.variacao > 0 ? '+' : ''}${a.variacao}%)`)
  for (const p of d.passos ?? []) linhas.push(`• ${p.texto}`)
  for (const f of d.fontes ?? []) if (f.url) linhas.push(`${f.titulo}: ${f.url}`)
  return linhas.join('\n').trim()
}

function Emails({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const itens: any[] = d.itens ?? []
  return (
    <>
      <Head card={card} icon={Mail} onClose={onClose} />
      {!d.configurado ? (
        <p className="card-ref">Gmail ainda não configurado. Adicione a conta no painel, em Fontes de dados.</p>
      ) : (
        <p className="card-ref">
          {d.total} não lidos nas últimas 24 h · {itens.length} pedem atenção
        </p>
      )}
      {itens.length > 0 && (
        <ul className="list mail">
          {itens.map((m, i) => (
            <li key={i}>
              <div>
                <strong>{m.assunto}</strong>
                <span className="muted">
                  {m.de} · {m.motivo}
                </span>
              </div>
              {m.acao && <span className="pill">{m.acao}</span>}
            </li>
          ))}
        </ul>
      )}
      <footer className="card-foot">
        <span>{d.outros ? `${d.outros} sem urgência` : 'Caixa sob controle'}</span>
        <span>{card.at}</span>
      </footer>
    </>
  )
}

function Agenda({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const evs: any[] = d.eventos ?? []
  return (
    <>
      <Head card={{ ...card, data: { ...d, categoria: `Agenda · ${d.hoje ?? 'Hoje'}` } }} icon={CalendarDays} onClose={onClose} />
      {!d.configurado ? (
        <p className="card-ref">Agenda ainda não configurada. Cole o link iCal no painel, em Fontes de dados.</p>
      ) : evs.length === 0 ? (
        <div className="free">
          <span className="free-big">Livre</span>
          <span className="muted">Nenhum compromisso hoje.</span>
        </div>
      ) : (
        <ol className="timeline">
          {evs.map((e, i) => (
            <li key={i}>
              <time>{e.dia_todo ? 'Dia todo' : e.inicio}</time>
              <div>
                <strong>{e.titulo}</strong>
                {(e.local || e.fim) && <span className="muted">{[e.fim && `até ${e.fim}`, e.local].filter(Boolean).join(' · ')}</span>}
              </div>
            </li>
          ))}
        </ol>
      )}
      <footer className="card-foot">
        <span>{evs.length ? `${evs.length} compromissos` : 'Dia livre'}</span>
        <span>{card.at}</span>
      </footer>
    </>
  )
}

function Noticia({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const [top, ...rest]: any[] = d.itens ?? []
  if (!top) return null
  return (
    <>
      <Head card={{ ...card, data: { categoria: `Notícias · ${d.tema}`, titulo: top.titulo } }} icon={Newspaper} onClose={onClose} />
      {top.imagem && <img className="news-img" src={top.imagem} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />}
      {top.trecho && <p className="news-lead">{top.trecho}</p>}
      {rest.length > 0 && (
        <ul className="list">
          {rest.slice(0, 3).map((n, i) => (
            <li key={i}>
              <div>
                <strong>{n.titulo}</strong>
                <span className="muted">{[n.fonte, n.data].filter(Boolean).join(' · ')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <footer className="card-foot">
        <span>{top.fonte ?? 'Fonte'}</span>
        {top.url ? (
          <a href={top.url} target="_blank" rel="noreferrer">
            Abrir matéria <ExternalLink size={10} />
          </a>
        ) : (
          <span>{card.at}</span>
        )}
      </footer>
    </>
  )
}

function Carregando({ card }: { card: Card }) {
  const etapas: string[] = card.data.etapas ?? []
  return (
    <>
      <Head card={card} icon={Loader2} />
      <p className="loading-title">{card.data.titulo}…</p>
      <div className="loading-steps">
        {etapas.map((e, i) => (
          <span key={e} style={{ animationDelay: `${i * 0.35}s` }}>
            {e}
          </span>
        ))}
      </div>
    </>
  )
}

function CameraCard({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  return (
    <>
      <Head card={{ ...card, data: { categoria: 'Câmera · Ao vivo', titulo: d.nome } }} icon={Camera} onClose={onClose} />
      <img className="news-img" src={`/api/cameras/${d.id}/foto?t=${d.ts}`} alt={`Imagem da câmera ${d.nome}`} />
      <footer className="card-foot">
        <span>{d.nome}</span>
        <span>Capturado às {card.at}</span>
      </footer>
    </>
  )
}

function Spark({ serie, up }: { serie: number[]; up: boolean }) {
  if (serie.length < 2) return null
  const min = Math.min(...serie)
  const max = Math.max(...serie)
  const pts = serie.map((v, i) => `${(i / (serie.length - 1)) * 100},${28 - ((v - min) / (max - min || 1)) * 26}`).join(' ')
  return (
    <svg className={`spark ${up ? 'up' : 'down'}`} viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} />
    </svg>
  )
}

const money = (v: number, cur?: string) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: v < 100 ? 2 : 0, maximumFractionDigits: v < 100 ? 2 : 0 }) + (cur && cur !== 'BRL' ? ` ${cur}` : '')

const PERIODOS: [string, string][] = [['1d', '1D'], ['5d', '5D'], ['1mo', '1M'], ['6mo', '6M'], ['1y', '1A']]

function Mercado({ card, onClose, onPeriod, preview }: { card: Card; onClose?: () => void; onPeriod?: (p: string) => void; preview?: string | null }) {
  const ativos: any[] = card.data.ativos ?? []
  const atual = preview ?? card.data.periodo ?? '1mo'
  return (
    <>
      <Head card={card} icon={LineChart} onClose={onClose} />
      <ul className="market">
        {ativos.map((a) => (
          <li key={a.simbolo}>
            <div className="m-name">
              <strong>{a.nome}</strong>
              <span className="muted">{a.simbolo}</span>
            </div>
            <Spark serie={a.serie ?? []} up={(a.variacao ?? 0) >= 0} />
            <div className="m-val">
              <b>{money(a.preco, a.moeda)}</b>
              <span className={(a.variacao ?? 0) >= 0 ? 'pos' : 'neg'}>
                {a.variacao == null ? '—' : `${a.variacao > 0 ? '+' : ''}${a.variacao.toLocaleString('pt-BR')}%`}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <footer className="card-foot">
        <span>Yahoo Finance · variação do dia</span>
        {onPeriod ? (
          <span className="periods" role="radiogroup" aria-label="Período do gráfico">
            {PERIODOS.map(([id, rot]) => (
              <button key={id} role="radio" aria-checked={atual === id} className={atual === id ? 'on' : ''} onClick={() => onPeriod(id)}>
                {rot}
              </button>
            ))}
          </span>
        ) : (
          <span>{card.at}</span>
        )}
      </footer>
    </>
  )
}

function Mensagens({ card, onClose }: { card: Card; onClose?: () => void }) {
  const msgs: any[] = card.data.mensagens ?? []
  return (
    <>
      <Head card={card} icon={MessageCircle} onClose={onClose} />
      {msgs.length === 0 ? (
        <p className="card-ref">Nenhuma mensagem nova.</p>
      ) : (
        <ul className="list">
          {msgs.slice(0, 6).map((m, i) => (
            <li key={i}>
              <div>
                <strong>{m.grupo ? `${m.de} · ${m.grupo}` : m.de}</strong>
                <span className="muted">{m.texto}</span>
              </div>
              <span className="pill">{m.quando}</span>
            </li>
          ))}
        </ul>
      )}
      <footer className="card-foot">
        <span>{msgs.length} {msgs.length === 1 ? 'mensagem' : 'mensagens'}</span>
        <span>{card.at}</span>
      </footer>
    </>
  )
}

const n0 = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: d }))

function Saude({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const t = d.ultimo_treino
  return (
    <>
      <Head card={{ ...card, data: { categoria: 'Saúde · Apple', titulo: d.dia ? `Seu dia ${d.dia.split('-').reverse().slice(0, 2).join('/')}` : 'Saúde' } }} icon={HeartPulse} onClose={onClose} />
      <ul className="weather-stats health">
        <li>
          <b>{n0(d.passos)}</b> passos
        </li>
        <li>
          <b>{n0(d.sono_h, 1)} h</b> de sono
        </li>
        <li>
          <b>{n0(d.fc_repouso)}</b> bpm repouso
        </li>
        <li>
          <b>{n0(d.vfc, 1)} ms</b> VFC
        </li>
      </ul>
      <p className="card-ref">
        Média de 7 dias: {n0(d.media7_passos)} passos e {n0(d.media7_sono, 1)} h de sono
        {t ? ` · último treino: ${t.tipo.replace(/([a-z])([A-Z])/g, '$1 $2')}, ${t.min} min` : ''}
      </p>
      <footer className="card-foot">
        <span>Exportado em {d.exportado_em}</span>
        <span>Não substitui avaliação médica</span>
      </footer>
    </>
  )
}

const brl = (v: unknown) =>
  typeof v === 'number' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : String(v ?? '')

/** Financeiro: lançamento (com Desfazer), resumo com barras ou lista (a pagar, faturas). */
function Financeiro({ card, onClose }: { card: Card; onClose?: () => void }) {
  const d = card.data
  const [desfeito, setDesfeito] = useState(false)
  const sinal = d.sinal === 'entrada' ? '+' : d.sinal === 'saida' ? '−' : ''
  const max = Math.max(1, ...((d.barras ?? []) as { valor: number; max?: number }[]).map((b) => b.max || b.valor || 0))
  return (
    <>
      <Head card={{ ...card, data: { categoria: d.modo === 'lancamento' ? (desfeito ? 'Financeiro · desfeito' : 'Financeiro · lançado') : 'Financeiro', titulo: d.titulo } }} icon={Wallet} onClose={onClose} />
      {typeof d.valor === 'number' && (
        <p className={`fin-valor ${d.sinal ?? ''} ${desfeito ? 'riscado' : ''}`}>
          {sinal}
          {brl(Math.abs(d.valor))}
        </p>
      )}
      {d.linhas?.length > 0 && (
        <ul className="fin-linhas">
          {d.linhas.map((l: { rotulo: string; valor: string; detalhe?: string; tom?: string }, i: number) => (
            <li key={i} className={l.tom ?? ''}>
              <span>{l.rotulo}</span>
              <b>{l.valor}</b>
              {l.detalhe && <small>{l.detalhe}</small>}
            </li>
          ))}
        </ul>
      )}
      {d.barras?.length > 0 && (
        <ul className="fin-barras">
          {d.barras.map((b: { rotulo: string; valor: number; max?: number }, i: number) => (
            <li key={i}>
              <span>{b.rotulo}</span>
              <b>
                {brl(b.valor)}
                {b.max ? <small> de {brl(b.max)}</small> : null}
              </b>
              <i style={{ width: `${Math.min(100, ((b.valor || 0) / (b.max || max)) * 100)}%` }} className={b.max && b.valor > b.max * 0.8 ? 'alto' : ''} />
            </li>
          ))}
        </ul>
      )}
      {d.aviso && <p className="fin-aviso">{d.aviso}</p>}
      {d.desfazer && !desfeito && (
        <footer className="card-foot">
          <button
            className="fin-desfazer"
            onClick={() => api('/api/fin/desfazer', { method: 'POST', json: d.desfazer }).then((r) => !r.erro && setDesfeito(true))}
          >
            <Undo2 size={13} /> Desfazer
          </button>
        </footer>
      )}
    </>
  )
}

export function CardView({ card, onClose, onPeriod, preview }: { card: Card; onClose?: () => void; onPeriod?: (p: string) => void; preview?: string | null }) {
  return (
    <article className={`card card-${card.kind}`} key={card.id}>
      {card.kind === 'pesquisa' && <Pesquisa card={card} onClose={onClose} />}
      {card.kind === 'clima' && <Clima card={card} onClose={onClose} />}
      {card.kind === 'lista' && <Lista card={card} onClose={onClose} />}
      {card.kind === 'emails' && <Emails card={card} onClose={onClose} />}
      {card.kind === 'agenda' && <Agenda card={card} onClose={onClose} />}
      {card.kind === 'noticia' && <Noticia card={card} onClose={onClose} />}
      {card.kind === 'carregando' && <Carregando card={card} />}
      {card.kind === 'camera' && <CameraCard card={card} onClose={onClose} />}
      {card.kind === 'mercado' && <Mercado card={card} onClose={onClose} onPeriod={onPeriod} preview={preview} />}
      {card.kind === 'mensagens' && <Mensagens card={card} onClose={onClose} />}
      {card.kind === 'saude' && <Saude card={card} onClose={onClose} />}
      {card.kind === 'plano' && <Plano card={card} onClose={onClose} />}
      {card.kind === 'financeiro' && <Financeiro card={card} onClose={onClose} />}
    </article>
  )
}

// Versão compacta para a faixa de cartões anteriores.
export function CardChip({ card, active, onClick, style }: { card: Card; active: boolean; onClick: () => void; style?: CSSProperties }) {
  const d = card.data
  const cat =
    card.kind === 'clima'
      ? d.cidade
      : card.kind === 'noticia'
        ? `Notícias · ${d.tema}`
        : card.kind === 'camera'
          ? 'Câmera'
          : card.kind === 'mercado'
            ? 'Mercado'
            : card.kind === 'mensagens' || card.kind === 'saude'
              ? labelFor(card.kind)
              : (d.categoria ?? labelFor(card.kind))
  const title =
    card.kind === 'clima'
      ? d.condicao
      : card.kind === 'noticia'
        ? d.itens?.[0]?.titulo
        : card.kind === 'agenda'
          ? d.eventos?.length
            ? `${d.eventos[0].inicio ?? 'Dia todo'} · ${d.eventos[0].titulo}`
            : 'Dia livre'
          : card.kind === 'emails'
            ? `${d.itens?.length ?? 0} pedem atenção`
            : card.kind === 'camera'
              ? d.nome
              : card.kind === 'mercado'
                ? (d.ativos ?? []).slice(0, 2).map((a: any) => `${a.nome} ${a.variacao > 0 ? '+' : ''}${a.variacao}%`).join(' · ')
                : card.kind === 'mensagens'
                  ? `${d.total ?? 0} de ${(d.mensagens ?? []).map((m: any) => m.de).slice(0, 2).join(', ') || '—'}`
                  : card.kind === 'saude'
                    ? `${n0(d.passos)} passos · ${n0(d.sono_h, 1)} h sono`
                    : d.titulo
  const big =
    card.kind === 'clima'
      ? `${num(d.temperatura)}°`
      : card.kind === 'pesquisa' && d.itens?.[0]
        ? d.itens[0].valor_texto ?? ''
        : ''
  return (
    <button className={`chip ${active ? 'is-active' : ''} ${style ? 'is-dragging' : ''}`} onClick={onClick} data-id={card.id} style={style}>
      {card.kind === 'noticia' && d.itens?.[0]?.imagem && (
        <img className="chip-img" src={d.itens[0].imagem} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = 'none')} />
      )}
      <span className="chip-cat">{cat}</span>
      <span className="chip-title">{title}</span>
      {big && <span className="chip-big">{big}</span>}
    </button>
  )
}
