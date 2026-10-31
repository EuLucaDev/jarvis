// Página de impressão (/impressao), aberta por um navegador sem tela no núcleo para virar imagem ou PDF:
//   ?cartao=<id>      um cartão do Jarvis sozinho, como aparece na tela (vira foto no Telegram)
//   ?relatorio=AAAA-MM o relatório do financeiro do mês: a 1ª página é o resumo (também vira imagem), as
//                      seguintes detalham categorias, contas e cartões, metas e os maiores gastos (o PDF)
// Quando termina de desenhar, marca window.__pronto = true (o núcleo espera isso para fotografar).

import { useEffect, useState } from 'react'
import { CardView } from '../hud/Cards'
import type { Card } from '../lib/socket'
import './impressao.css'

declare global {
  interface Window {
    __pronto?: boolean
  }
}

type Rel = {
  mes: string
  rotulo: string
  nome: string
  gerado: string
  d: Record<string, any>
  maiores: { descricao: string; categoria: string; valor: number; data: string }[]
  anterior: { entradas: number; saidas: number } | null
}

const brl = (v: number) => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const pct = (v: number) => `${Math.round(v ?? 0)}%`
const FORMAS: Record<string, string> = {
  PIX: 'Pix',
  DEBITO: 'Débito',
  DINHEIRO: 'Dinheiro',
  CARTAO_CREDITO: 'Cartão de crédito',
  VALE_BENEFICIO: 'Vale / benefício',
  META: 'Meta (caixinha)',
}
const CORES = ['#5fd4ff', '#7cf29a', '#ffb547', '#c792ff', '#ff6b8a', '#4ea8ff', '#3fd3e8', '#e8f4ff']

export function Impressao() {
  const q = new URLSearchParams(location.search)
  const id = q.get('cartao')
  const mes = q.get('relatorio')
  const [card, setCard] = useState<Card | null>(null)
  const [rel, setRel] = useState<Rel | null>(null)
  const [erro, setErro] = useState('')

  useEffect(() => {
    const url = id ? `/api/impressao/cartao/${id}` : `/api/impressao/relatorio?mes=${mes}`
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((x) => (id ? setCard(x) : setRel(x)))
      .catch((e) => setErro(String(e)))
  }, [id, mes])

  useEffect(() => {
    if (!card && !rel && !erro) return
    // fontes e desenho prontos antes da foto
    document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => (window.__pronto = true))))
  }, [card, rel, erro])

  if (erro) return <main className="imp imp-erro">{erro}</main>
  if (card)
    return (
      <main className="imp imp-cartao" id="alvo">
        <CardView card={card} />
        <footer className="imp-marca">J.A.R.V.I.S.</footer>
      </main>
    )
  if (!rel) return <main className="imp" />
  return <Relatorio r={rel} soResumo={q.get('so') === 'resumo'} />
}

function Kpi({ rotulo, valor, sub, tom }: { rotulo: string; valor: string; sub?: string; tom?: string }) {
  return (
    <div className={`imp-kpi ${tom ?? ''}`}>
      <small>{rotulo}</small>
      <b>{valor}</b>
      {sub && <span>{sub}</span>}
    </div>
  )
}

function Barras({ itens, max }: { itens: { name: string; value: number }[]; max?: number }) {
  const m = max ?? Math.max(1, ...itens.map((i) => i.value))
  return (
    <ul className="imp-barras">
      {itens.map((i, n) => (
        <li key={i.name}>
          <span>{i.name}</span>
          <i>
            <em style={{ width: `${Math.max(2, (i.value / m) * 100)}%`, background: CORES[n % CORES.length] }} />
          </i>
          <b>{brl(i.value)}</b>
        </li>
      ))}
    </ul>
  )
}

function Meses({ meses }: { meses: { label: string; income: number; outflow: number }[] }) {
  const m = Math.max(1, ...meses.flatMap((x) => [x.income, x.outflow]))
  const W = 560
  const H = 150
  const passo = W / meses.length
  return (
    <svg className="imp-meses" viewBox={`0 0 ${W} ${H + 22}`} role="img" aria-label="Entradas e saídas por mês">
      {meses.map((x, i) => {
        const hi = (x.income / m) * H
        const ho = (x.outflow / m) * H
        const cx = i * passo + passo / 2
        return (
          <g key={x.label}>
            <rect x={cx - 15} y={H - hi} width={13} height={hi} rx={3} fill="#7cf29a" />
            <rect x={cx + 2} y={H - ho} width={13} height={ho} rx={3} fill="#5fd4ff" />
            <text x={cx} y={H + 16} textAnchor="middle">
              {x.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Rosca({ itens }: { itens: { name: string; value: number }[] }) {
  const total = itens.reduce((a, b) => a + b.value, 0) || 1
  const cheias = itens.filter((i) => i.value > 0)
  if (cheias.length <= 1)
    // uma categoria só: o arco de 360° não se desenha; vai um anel inteiro
    return (
      <svg className="imp-rosca" viewBox="0 0 160 160" role="img" aria-label="Gastos por categoria">
        <circle cx="80" cy="80" r="58" fill="none" stroke={cheias.length ? CORES[0] : 'rgb(95 212 255 / 0.15)'} strokeWidth="24" />
      </svg>
    )
  let ang = -Math.PI / 2
  const R = 70
  const r = 46
  const arcos = itens.map((i, n) => {
    const a0 = ang
    const a1 = ang + (i.value / total) * Math.PI * 2
    ang = a1
    const grande = a1 - a0 > Math.PI ? 1 : 0
    const p = (a: number, raio: number) => `${80 + raio * Math.cos(a)} ${80 + raio * Math.sin(a)}`
    return (
      <path
        key={i.name}
        d={`M ${p(a0, R)} A ${R} ${R} 0 ${grande} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${grande} 0 ${p(a0, r)} Z`}
        fill={CORES[n % CORES.length]}
      />
    )
  })
  return (
    <svg className="imp-rosca" viewBox="0 0 160 160" role="img" aria-label="Gastos por categoria">
      {arcos}
    </svg>
  )
}

function Relatorio({ r, soResumo }: { r: Rel; soResumo?: boolean }) {
  const d = r.d
  const cats: { name: string; value: number }[] = (d.expensesByCategory ?? []).slice(0, 8)
  const meses = (d.incomesVsOutflowsByMonth ?? []).filter((x: any) => x.month <= Number(r.mes.slice(5, 7))).slice(-6)
  const saude = d.intelligence?.health
  const varSaidas = r.anterior && r.anterior.saidas ? ((d.totalOutflow - r.anterior.saidas) / r.anterior.saidas) * 100 : null
  return (
    <main className="imp imp-rel">
      <section className="imp-pagina" id="resumo">
        <header className="imp-topo">
          <div>
            <small>J.A.R.V.I.S. · financeiro</small>
            <h1>{r.rotulo.charAt(0).toUpperCase() + r.rotulo.slice(1)}</h1>
            <p>{r.nome}</p>
          </div>
          {saude && (
            <div className={`imp-saude ${saude.tone}`}>
              <b>{saude.score}</b>
              <span>saúde financeira · {saude.label}</span>
            </div>
          )}
        </header>
        <div className="imp-kpis">
          <Kpi rotulo="Entradas" valor={brl(d.totalIncome)} tom="bom" />
          <Kpi
            rotulo="Saídas"
            valor={brl(d.totalOutflow)}
            sub={varSaidas == null ? undefined : `${varSaidas > 0 ? '+' : ''}${Math.round(varSaidas)}% que no mês anterior`}
            tom="saida"
          />
          <Kpi rotulo="Sobra" valor={brl(d.leftover)} sub={`guardou ${pct(d.savingRate)} do que entrou`} tom={d.leftover >= 0 ? 'bom' : 'ruim'} />
          <Kpi rotulo="Saldo total" valor={brl(d.totalBalance)} sub={d.openInvoiceTotal ? `faturas abertas ${brl(d.openInvoiceTotal)}` : undefined} />
        </div>
        <div className="imp-duas">
          <div className="imp-bloco">
            <h2>Para onde foi</h2>
            <div className="imp-cat">
              <Rosca itens={cats} />
              <Barras itens={cats.slice(0, 6)} />
            </div>
          </div>
          <div className="imp-bloco">
            <h2>Entradas e saídas</h2>
            <Meses meses={meses} />
            <p className="imp-legenda">
              <i className="ent" /> entradas <i className="sai" /> saídas
            </p>
          </div>
        </div>
        <footer className="imp-rodape">Gerado pelo Jarvis em {r.gerado}</footer>
      </section>
      {!soResumo && (
        <>

      <section className="imp-pagina">
        <h2 className="imp-h">Contas e cartões</h2>
        <div className="imp-duas">
          <div className="imp-bloco">
            <h3>Contas</h3>
            <ul className="imp-linhas">
              {(d.bankAccounts ?? []).map((a: any) => (
                <li key={a.id}>
                  <span>
                    <i style={{ background: a.color }} /> {a.name}
                  </span>
                  <b>{brl(a.currentBalance)}</b>
                </li>
              ))}
            </ul>
          </div>
          <div className="imp-bloco">
            <h3>Faturas do mês</h3>
            <ul className="imp-linhas">
              {(d.invoicesByCard ?? []).map((c: any) => (
                <li key={c.id}>
                  <span>
                    <i style={{ background: c.color }} /> {c.name}
                  </span>
                  <b>{brl(c.value)}</b>
                </li>
              ))}
              {!(d.invoicesByCard ?? []).length && <li className="vazio">Nenhum cartão de crédito</li>}
            </ul>
          </div>
        </div>
        <div className="imp-duas">
          <div className="imp-bloco">
            <h3>Formas de pagamento</h3>
            <Barras itens={(d.expensesByPaymentMethod ?? []).map((x: any) => ({ ...x, name: FORMAS[x.name] ?? x.name }))} />
          </div>
          <div className="imp-bloco">
            <h3>Fixo e variável</h3>
            <Barras
              itens={[
                { name: 'Fixas', value: d.fixedVsVariable?.fixed ?? 0 },
                { name: 'Variáveis', value: d.fixedVsVariable?.variable ?? 0 },
              ]}
            />
          </div>
        </div>
        <h2 className="imp-h">Orçamento</h2>
        <ul className="imp-orc">
          {(d.budgets ?? [])
            .filter((b: any) => b.limit > 0)
            .map((b: any) => (
              <li key={b.category} className={b.pct >= 100 ? 'ruim' : b.pct >= 80 ? 'aviso' : ''}>
                <span>{b.category}</span>
                <i>
                  <em style={{ width: `${Math.min(100, b.pct)}%` }} />
                </i>
                <b>
                  {brl(b.used)} de {brl(b.limit)}
                </b>
              </li>
            ))}
          {!(d.budgets ?? []).some((b: any) => b.limit > 0) && <li className="vazio">Sem orçamento definido (peça ao Jarvis: "sugere um orçamento")</li>}
        </ul>
      </section>

      <section className="imp-pagina">
        <h2 className="imp-h">Metas</h2>
        <ul className="imp-orc">
          {(d.goals ?? []).map((g: any) => {
            const p = g.targetAmount ? (g.savedAmount / g.targetAmount) * 100 : 0
            return (
              <li key={g.id}>
                <span>{g.name}</span>
                <i>
                  <em style={{ width: `${Math.min(100, p)}%`, background: g.color }} />
                </i>
                <b>
                  {brl(g.savedAmount)} de {brl(g.targetAmount)}
                </b>
              </li>
            )
          })}
          {!(d.goals ?? []).length && <li className="vazio">Nenhuma meta ainda</li>}
        </ul>
        <h2 className="imp-h">Maiores gastos do mês</h2>
        <table className="imp-tab">
          <thead>
            <tr>
              <th>Data</th>
              <th>Descrição</th>
              <th>Categoria</th>
              <th className="num">Valor</th>
            </tr>
          </thead>
          <tbody>
            {r.maiores.map((m, i) => (
              <tr key={i}>
                <td>{m.data.split('-').reverse().slice(0, 2).join('/')}</td>
                <td>{m.descricao}</td>
                <td>{m.categoria}</td>
                <td className="num">{brl(m.valor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer className="imp-rodape">J.A.R.V.I.S. · {r.rotulo} · os dados ficam no seu Jarvis</footer>
      </section>
        </>
      )}
    </main>
  )
}
