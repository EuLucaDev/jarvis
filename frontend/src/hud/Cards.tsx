import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSun,
  Droplets,
  ExternalLink,
  ListChecks,
  Search,
  Sun,
  Umbrella,
  Wind,
  X,
} from 'lucide-react'
import type { Card } from '../lib/socket'

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
  return { pesquisa: 'Pesquisa', clima: 'Clima · Agora', lista: 'Lista' }[kind]
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

export function CardView({ card, onClose }: { card: Card; onClose?: () => void }) {
  return (
    <article className={`card card-${card.kind}`} key={card.id}>
      {card.kind === 'pesquisa' && <Pesquisa card={card} onClose={onClose} />}
      {card.kind === 'clima' && <Clima card={card} onClose={onClose} />}
      {card.kind === 'lista' && <Lista card={card} onClose={onClose} />}
    </article>
  )
}

// Versão compacta para a faixa de cartões anteriores.
export function CardChip({ card, active, onClick }: { card: Card; active: boolean; onClick: () => void }) {
  const d = card.data
  const big =
    card.kind === 'clima'
      ? `${num(d.temperatura)}°`
      : card.kind === 'pesquisa' && d.itens?.[0]
        ? d.itens[0].valor_texto ?? ''
        : ''
  return (
    <button className={`chip ${active ? 'is-active' : ''}`} onClick={onClick}>
      <span className="chip-cat">{card.kind === 'clima' ? d.cidade : (d.categoria ?? labelFor(card.kind))}</span>
      <span className="chip-title">{card.kind === 'clima' ? d.condicao : d.titulo}</span>
      {big && <span className="chip-big">{big}</span>}
    </button>
  )
}
