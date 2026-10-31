// Site do Jarvis (jarvis.agcunae.com/site), servido pela portaria na VPS. Estilo WorkFlow com a marca do Jarvis.
//   /site                          entrar; depois o painel: início (ponte ao vivo + instalar), Telegram, segurança
//                                  e, para o administrador, contas, robô do Telegram e versões
//   /site/primeiro-acesso/<token>  a pessoa convidada cria a senha
// Só entra quem tem conta; quem cria as contas é o administrador. Todo pedido leva o cabeçalho x-jarvis (a portaria
// recusa o que vier sem ele: outro site não consegue mandar pedidos em nome de quem está logado).

import {
  Apple,
  ArrowRight,
  Check,
  Cloud,
  Copy,
  Download,
  Eye,
  EyeOff,
  Home,
  KeyRound,
  Laptop,
  LogOut,
  Monitor,
  MoreHorizontal,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import "./site.css";

type Disp = {
  id: string;
  sistema: string;
  nome: string;
  jarvis?: string;
  launcher?: string;
  visto?: string;
};
type Conta = {
  id: string;
  nome: string;
  email: string;
  admin: boolean;
  ativa: boolean;
  criado?: string;
  ultimo_uso?: string | null;
  senha_definida?: boolean;
  dispositivos: Disp[];
  telegram_ligado?: boolean;
  conectado?: boolean;
  bolso?: boolean;
};
type Bolso = { pronto: boolean; copia_em: number | null; pendentes: number };
type Eu = Conta & {
  robo?: string;
  versoes: Record<string, { versao: string; data: string } | null>;
  launcher: Record<string, boolean>;
  bolso?: Bolso;
  sessoes?: number;
};
type Versao = { versao: string; data: string; notas?: string };

class ErroApi extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

async function chamar<T = any>(
  url: string,
  metodo = "GET",
  corpo?: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method: metodo,
    credentials: "same-origin",
    headers: {
      "x-jarvis": "site",
      ...(corpo ? { "content-type": "application/json" } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg =
      typeof dados.detail === "string"
        ? dados.detail
        : r.status === 401
          ? "Sua sessão terminou. Entre de novo."
          : `Não deu certo (erro ${r.status}).`;
    throw new ErroApi(msg, r.status);
  }
  return dados as T;
}

const SISTEMAS = [
  {
    id: "mac",
    nome: "Mac",
    icone: Apple,
    dica: "Apple Silicon (M1 ou mais novo)",
    aviso:
      "Na primeira vez: Ajustes do Sistema → Privacidade e Segurança → “Abrir Mesmo Assim”.",
  },
  {
    id: "windows",
    nome: "Windows",
    icone: Monitor,
    dica: "Windows 10 ou 11",
    aviso:
      "Se aparecer o aviso azul: “Mais informações” → “Executar assim mesmo”.",
  },
  {
    id: "linux",
    nome: "Linux",
    icone: Laptop,
    dica: "AppImage (X11)",
    aviso: "Dê permissão de execução ao arquivo e abra.",
  },
];
const nomeSistema = (s: string) => SISTEMAS.find((x) => x.id === s)?.nome ?? s;
const meuSistema = () => {
  const ua = navigator.userAgent;
  return /Mac/i.test(ua)
    ? "mac"
    : /Win/i.test(ua)
      ? "windows"
      : /Linux|X11/i.test(ua)
        ? "linux"
        : "mac";
};
const CORES = [
  "var(--label-cyan)",
  "var(--label-lavender)",
  "var(--label-mint)",
  "var(--label-amber)",
  "var(--label-coral)",
  "var(--label-sky)",
  "var(--label-rose)",
];
const corDe = (s: string) =>
  CORES[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % CORES.length];
const iniciais = (nome: string) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
const primeiro = (nome: string) => nome.split(" ")[0];
const horaDe = (t: number | null | undefined) => {
  if (!t) return "—";
  const d = new Date(t * 1000);
  const mesmoDia = d.toDateString() === new Date().toDateString();
  return mesmoDia
    ? `hoje às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`
    : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};
const cor = (s: string) => ({ "--c": corDe(s) }) as React.CSSProperties;

// ---------------------------------------------------------------- avisos (toasts)

type Aviso = { id: number; texto: string; erro?: boolean };
type Avisar = (m: string, erro?: boolean) => void;
function useAvisos() {
  const [lista, setLista] = useState<Aviso[]>([]);
  const avisar = useCallback<Avisar>((texto, erro = false) => {
    const id = Date.now() + Math.random();
    setLista((l) => [...l, { id, texto, erro }]);
    setTimeout(
      () => setLista((l) => l.filter((a) => a.id !== id)),
      erro ? 6000 : 3500,
    );
  }, []);
  const no = (
    <div className="jv-avisos" role="status" aria-live="polite">
      {lista.map((a) => (
        <div key={a.id} className={`jv-aviso ${a.erro ? "erro" : ""}`}>
          {a.erro ? <X size={15} /> : <Check size={15} />} {a.texto}
        </div>
      ))}
    </div>
  );
  return [avisar, no] as const;
}

// ---------------------------------------------------------------- peças

function Esfera({ grande }: { grande?: boolean }) {
  return (
    <div className={`jv-esfera ${grande ? "grande" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  );
}

function Marca() {
  return (
    <div className="jv-marca">
      <Esfera />
      <span>J.A.R.V.I.S.</span>
    </div>
  );
}

function Campo({
  rotulo,
  dica,
  children,
}: {
  rotulo: string;
  dica?: string;
  children: ReactNode;
}) {
  return (
    <label className="jv-campo">
      <span className="jv-rotulo">{rotulo}</span>
      {children}
      {dica && <span className="jv-dica">{dica}</span>}
    </label>
  );
}

function Senha({
  valor,
  mudar,
  nova,
  placeholder,
  autoFocus,
}: {
  valor: string;
  mudar: (v: string) => void;
  nova?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [ver, setVer] = useState(false);
  const [caps, setCaps] = useState(false);
  return (
    <>
      <span className="jv-senha">
        <input
          className="jv-input"
          type={ver ? "text" : "password"}
          autoComplete={nova ? "new-password" : "current-password"}
          minLength={nova ? 8 : undefined}
          value={valor}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onChange={(e) => mudar(e.target.value)}
          onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
          required
        />
        <button
          type="button"
          className="jv-olho"
          onClick={() => setVer((v) => !v)}
          aria-label={ver ? "Esconder a senha" : "Mostrar a senha"}
        >
          {ver ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
      {caps && <span className="jv-dica aviso">Caps Lock ligado</span>}
    </>
  );
}

function forca(s: string) {
  let p = 0;
  if (s.length >= 8) p++;
  if (s.length >= 12) p++;
  if (/[A-Z]/.test(s) && /[a-z]/.test(s)) p++;
  if (/\d/.test(s) && /[^\w]/.test(s)) p++;
  return {
    nivel: p,
    texto: ["Muito fraca", "Fraca", "Razoável", "Boa", "Forte"][p],
  };
}

function Forca({ senha }: { senha: string }) {
  if (!senha) return null;
  const f = forca(senha);
  return (
    <div className="jv-forca" data-nivel={f.nivel}>
      <span>
        <i />
        <i />
        <i />
        <i />
      </span>
      {f.texto}
    </div>
  );
}

type BotaoProps = {
  tipo?: "primario" | "secundario" | "fantasma" | "perigo";
  icone?: ReactNode;
  carregando?: boolean;
  pilula?: boolean;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;
function Botao({
  tipo = "secundario",
  icone,
  carregando,
  pilula,
  children,
  className,
  ...resto
}: BotaoProps) {
  return (
    <button
      className={`jv-btn ${tipo} ${pilula ? "pilula" : ""} ${className ?? ""}`}
      aria-busy={carregando || undefined}
      {...resto}
      disabled={carregando || resto.disabled}
    >
      {carregando ? <span className="jv-giro" /> : icone}
      {children}
    </button>
  );
}

function Selo({ tom, children }: { tom?: string; children: ReactNode }) {
  return (
    <span className="jv-selo" data-tom={tom}>
      <i />
      {children}
    </span>
  );
}

function Janela({
  titulo,
  desc,
  fechar,
  children,
  largura,
}: {
  titulo: string;
  desc?: string;
  fechar: () => void;
  children: ReactNode;
  largura?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => e.key === "Escape" && fechar();
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [fechar]);
  return (
    <div
      className="jv-fundo"
      onMouseDown={(e) => e.target === e.currentTarget && fechar()}
    >
      <div
        className="jv-janela"
        role="dialog"
        aria-modal="true"
        aria-label={titulo}
        ref={ref}
        style={largura ? { width: `min(${largura}px, 100%)` } : undefined}
      >
        <header>
          <div>
            <h2>{titulo}</h2>
            {desc && <p>{desc}</p>}
          </div>
          <button className="jv-icone" onClick={fechar} aria-label="Fechar">
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

function Vazio({
  icone,
  titulo,
  desc,
}: {
  icone: ReactNode;
  titulo: string;
  desc: string;
}) {
  return (
    <div className="jv-vazio">
      <span className="jv-vazio-icone">{icone}</span>
      <b>{titulo}</b>
      <p>{desc}</p>
    </div>
  );
}

function Erro({ texto }: { texto: string }) {
  return texto ? (
    <p className="jv-erro" role="alert">
      {texto}
    </p>
  ) : null;
}

// ---------------------------------------------------------------- entrada

export function Site() {
  const link = location.pathname.match(/^\/site\/primeiro-acesso\/([^/]+)/);
  const [eu, setEu] = useState<Eu | null | undefined>(undefined);
  const carregar = useCallback(
    () =>
      chamar<Eu>("/api/site/eu")
        .then(setEu)
        .catch((e: ErroApi) =>
          e.status === 401 || e.status === 403 ? setEu(null) : undefined,
        ),
    [],
  );
  useEffect(() => {
    document.title = "Jarvis";
    document.documentElement.classList.add("pagina-site");
    if (!link) carregar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (link) return <PrimeiroAcesso token={link[1]!} />;
  if (eu === undefined)
    return (
      <main className="jv jv-carregando">
        <Esfera grande />
      </main>
    );
  if (!eu) return <Entrar aoEntrar={carregar} />;
  return <Painel eu={eu} recarregar={carregar} />;
}

function Porta({
  titulo,
  desc,
  children,
}: {
  titulo: string;
  desc: string;
  children: ReactNode;
}) {
  return (
    <main className="jv jv-porta">
      <section className="jv-porta-arte">
        <Marca />
        <div className="jv-porta-centro">
          <Esfera grande />
        </div>
        <div>
          <h1>Seu Jarvis, onde você estiver.</h1>
          <p>
            No computador, com voz, mãos e o seu financeiro. No celular, pelo
            Telegram, mesmo com o computador desligado.
          </p>
        </div>
      </section>
      <section className="jv-porta-form">
        <div className="jv-porta-caixa">
          <div className="jv-porta-marca-celular">
            <Marca />
          </div>
          <h2>{titulo}</h2>
          <p className="jv-mudo">{desc}</p>
          {children}
          <p className="jv-porta-rodape">
            <ShieldCheck size={14} /> Conexão protegida. As senhas são guardadas
            embaralhadas (scrypt): ninguém consegue vê-las, nem o administrador.
          </p>
        </div>
      </section>
    </main>
  );
}

function Entrar({ aoEntrar }: { aoEntrar: () => void }) {
  const [email, setEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setIndo(true);
    setErro("");
    try {
      await chamar("/api/site/entrar", "POST", { email, senha });
      aoEntrar();
    } catch (x) {
      setErro((x as Error).message);
    } finally {
      setIndo(false);
    }
  };
  return (
    <Porta
      titulo="Entrar"
      desc="O Jarvis é particular: só entra quem tem conta. As contas são criadas pelo administrador."
    >
      <form className="jv-form" onSubmit={enviar}>
        <Campo rotulo="E-mail">
          <input
            className="jv-input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </Campo>
        <Campo rotulo="Senha">
          <Senha valor={senha} mudar={setSenha} />
        </Campo>
        <Erro texto={erro} />
        <Botao tipo="primario" carregando={indo} className="grande">
          Entrar <ArrowRight size={16} />
        </Botao>
      </form>
    </Porta>
  );
}

function PrimeiroAcesso({ token }: { token: string }) {
  const [quem, setQuem] = useState<{ nome: string; email: string } | null>(
    null,
  );
  const [erro, setErro] = useState("");
  const [senha, setSenha] = useState("");
  const [senha2, setSenha2] = useState("");
  const [indo, setIndo] = useState(false);
  useEffect(() => {
    document.title = "Jarvis · Primeiro acesso";
    document.documentElement.classList.add("pagina-site");
    chamar(`/api/site/primeiro-acesso/${token}`)
      .then(setQuem)
      .catch((e: ErroApi) =>
        setErro(
          e.status === 404
            ? "Este link não vale mais (passou de 7 dias ou já foi usado). Peça um novo ao administrador."
            : e.message,
        ),
      );
  }, [token]);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (senha !== senha2) return setErro("As duas senhas não são iguais.");
    if (forca(senha).nivel < 2)
      return setErro(
        "Use uma senha mais forte: 12 letras ou mais, ou misture letras, números e símbolos.",
      );
    setIndo(true);
    try {
      await chamar(`/api/site/primeiro-acesso/${token}`, "POST", { senha });
      location.href = "/site";
    } catch (x) {
      setErro((x as Error).message);
      setIndo(false);
    }
  };
  return (
    <Porta
      titulo={quem ? `Olá, ${primeiro(quem.nome)}` : "Primeiro acesso"}
      desc={
        quem
          ? `Crie a senha da sua conta (${quem.email}). Ela vale no site e no Jarvis Launcher.`
          : erro
            ? "Não deu para abrir o convite."
            : "Conferindo o seu convite…"
      }
    >
      {quem ? (
        <form className="jv-form" onSubmit={enviar}>
          <Campo
            rotulo="Senha"
            dica="Pelo menos 8 caracteres. Uma frase curta é forte e fácil de lembrar."
          >
            <Senha valor={senha} mudar={setSenha} nova autoFocus />
          </Campo>
          <Forca senha={senha} />
          <Campo rotulo="Repita a senha">
            <Senha valor={senha2} mudar={setSenha2} nova />
          </Campo>
          <Erro texto={erro} />
          <Botao tipo="primario" carregando={indo} className="grande">
            Criar senha e entrar <ArrowRight size={16} />
          </Botao>
        </form>
      ) : (
        <Erro texto={erro} />
      )}
    </Porta>
  );
}

// ---------------------------------------------------------------- painel

type Pagina =
  "inicio" | "telegram" | "seguranca" | "contas" | "robo" | "versoes";
const PAGINAS: {
  id: Pagina;
  nome: string;
  curto: string;
  icone: typeof Home;
  admin?: boolean;
}[] = [
  { id: "inicio", nome: "Início", curto: "Início", icone: Home },
  { id: "telegram", nome: "Telegram", curto: "Telegram", icone: Send },
  {
    id: "seguranca",
    nome: "Segurança",
    curto: "Segurança",
    icone: ShieldCheck,
  },
  { id: "contas", nome: "Contas", curto: "Contas", icone: Users, admin: true },
  {
    id: "robo",
    nome: "Robô do Telegram",
    curto: "Robô",
    icone: Cloud,
    admin: true,
  },
  {
    id: "versoes",
    nome: "Versões",
    curto: "Versões",
    icone: Package,
    admin: true,
  },
];

function usePagina(admin: boolean): [Pagina, (p: Pagina) => void] {
  const ler = useCallback((): Pagina => {
    const h = location.hash.slice(1);
    const ok = PAGINAS.find((p) => p.id === h && (!p.admin || admin));
    return ok ? ok.id : "inicio";
  }, [admin]);
  const [p, setP] = useState<Pagina>(ler);
  useEffect(() => {
    const f = () => setP(ler());
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, [ler]);
  return [p, (x) => (location.hash = x)];
}

function Painel({ eu, recarregar }: { eu: Eu; recarregar: () => void }) {
  const [pagina, ir] = usePagina(eu.admin);
  const [avisar, avisos] = useAvisos();
  useEffect(() => {
    const t = setInterval(recarregar, 20000); // a ponte ao vivo: o estado do Jarvis de verdade
    return () => clearInterval(t);
  }, [recarregar]);
  const sair = async () => {
    await chamar("/api/site/sair", "POST").catch(() => null);
    location.href = "/site";
  };
  const visiveis = PAGINAS.filter((p) => !p.admin || eu.admin);
  const atual = PAGINAS.find((p) => p.id === pagina)!;
  const item = (p: (typeof PAGINAS)[number]) => (
    <a
      key={p.id}
      href={`#${p.id}`}
      className="jv-item"
      aria-current={pagina === p.id ? "page" : undefined}
    >
      <p.icone /> {p.nome}
    </a>
  );
  return (
    <div className="jv jv-casca">
      <aside className="jv-lateral">
        <Marca />
        <nav>
          {visiveis.filter((p) => !p.admin).map(item)}
          {eu.admin && <div className="jv-grupo">Administração</div>}
          {visiveis.filter((p) => p.admin).map(item)}
        </nav>
        <div className="jv-eu">
          <span className="jv-av" style={cor(eu.email)}>
            {iniciais(eu.nome)}
          </span>
          <div>
            <b>{eu.nome}</b>
            <small>{eu.admin ? "Administrador" : eu.email}</small>
          </div>
          <button
            className="jv-icone"
            onClick={sair}
            aria-label="Sair"
            title="Sair"
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      <div className="jv-palco-fora">
        <main className="jv-palco">
          <header className="jv-topo">
            <span className="jv-topo-titulo">{atual.nome}</span>
            <StatusAoVivo eu={eu} />
            <button
              className="jv-icone jv-so-celular"
              onClick={sair}
              aria-label="Sair"
            >
              <LogOut size={16} />
            </button>
          </header>
          <div className="jv-conteudo" key={pagina}>
            {pagina === "inicio" && <Inicio eu={eu} ir={ir} />}
            {pagina === "telegram" && <TelegramPagina eu={eu} />}
            {pagina === "seguranca" && <Seguranca eu={eu} avisar={avisar} />}
            {pagina === "contas" && <Contas eu={eu} avisar={avisar} />}
            {pagina === "robo" && (
              <Robo eu={eu} avisar={avisar} recarregar={recarregar} />
            )}
            {pagina === "versoes" && <Versoes />}
          </div>
        </main>
      </div>
      <nav className="jv-baixo">
        {visiveis.map((p) => (
          <a
            key={p.id}
            href={`#${p.id}`}
            aria-current={pagina === p.id ? "page" : undefined}
          >
            <p.icone />
            <span>{p.curto}</span>
          </a>
        ))}
      </nav>
      {avisos}
    </div>
  );
}

function estadoDe(eu: Eu) {
  if (eu.conectado) return { id: "ligado", texto: "Jarvis ligado", tom: "bom" };
  if (eu.bolso?.pronto)
    return { id: "bolso", texto: "Jarvis de bolso", tom: "sinal" };
  return { id: "desligado", texto: "Jarvis desligado", tom: undefined };
}

function StatusAoVivo({ eu }: { eu: Eu }) {
  const e = estadoDe(eu);
  return (
    <span className="jv-aovivo" data-tom={e.tom}>
      <i />
      {e.texto}
    </span>
  );
}

function Cabecalho({
  titulo,
  desc,
  children,
}: {
  titulo: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="jv-cabecalho">
      <div>
        <h1>{titulo}</h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="jv-cabecalho-acoes">{children}</div>}
    </div>
  );
}

/** A ponte ao vivo (o objeto vivo do site): computador ↔ conta ↔ Telegram, com o estado real do Jarvis. */
function Ponte({ eu }: { eu: Eu }) {
  const e = estadoDe(eu);
  const tg = !!eu.telegram_ligado;
  const frase =
    e.id === "ligado"
      ? "Seu Jarvis está ligado. As mensagens do Telegram chegam direto no computador, com tudo: financeiro, memória e os seus sistemas."
      : e.id === "bolso"
        ? `O computador está desligado, e o Jarvis de bolso responde pelo Telegram com a cópia de ${horaDe(eu.bolso?.copia_em)}. O que você lançar entra no financeiro quando o computador ligar.`
        : eu.dispositivos.length
          ? "O computador está desligado. As mensagens do Telegram ficam guardadas até ele ligar."
          : "Instale o Jarvis pelo launcher para começar. Ele se liga a esta conta sozinho.";
  return (
    <section className="jv-painel jv-ponte" data-estado={e.id}>
      <div className="jv-ponte-linha" aria-hidden="true">
        <div className={`jv-no ${e.id === "ligado" ? "vivo" : ""}`}>
          <span className="jv-no-icone">
            <Laptop />
          </span>
          <span>Computador</span>
          <small>
            {e.id === "ligado"
              ? "ligado agora"
              : eu.dispositivos.length
                ? "desligado"
                : "sem Jarvis"}
          </small>
        </div>
        <div className={`jv-trilho ${e.id === "ligado" ? "vivo" : ""}`}>
          <b />
        </div>
        <div className={`jv-no ${e.id !== "desligado" ? "vivo" : ""}`}>
          <span className="jv-no-icone">
            <Cloud />
          </span>
          <span>Sua conta</span>
          <small>
            {e.id === "bolso"
              ? `cópia de ${horaDe(eu.bolso?.copia_em)}`
              : "jarvis.agcunae.com"}
          </small>
        </div>
        <div
          className={`jv-trilho volta ${tg && e.id !== "desligado" ? "vivo" : ""}`}
        >
          <b />
        </div>
        <div className={`jv-no ${tg ? "vivo" : ""}`}>
          <span className="jv-no-icone">
            <Send />
          </span>
          <span>Telegram</span>
          <small>{tg ? `@${eu.robo ?? "robô"}` : "não ligado"}</small>
        </div>
      </div>
      <p className="jv-ponte-frase">{frase}</p>
      {!!eu.bolso?.pendentes && (
        <p className="jv-mudo pequeno">
          {eu.bolso.pendentes}{" "}
          {eu.bolso.pendentes === 1
            ? "registro feito pelo celular espera"
            : "registros feitos pelo celular esperam"}{" "}
          o computador ligar.
        </p>
      )}
    </section>
  );
}

function Inicio({ eu, ir }: { eu: Eu; ir: (p: Pagina) => void }) {
  const agora = new Date();
  const hora = agora.getHours();
  const saudacao =
    hora < 12 ? "Bom dia" : hora < 18 ? "Boa tarde" : "Boa noite";
  const sis = meuSistema();
  const s = SISTEMAS.find((x) => x.id === sis)!;
  const pronto = eu.launcher[sis];
  return (
    <>
      <div className="jv-ola">
        <span className="jv-ola-dia">{agora.getDate()}</span>
        <div>
          <div className="jv-mudo">
            {`${agora.toLocaleDateString("pt-BR", { weekday: "long" })}, ${agora.toLocaleDateString("pt-BR", { month: "long" })} de ${agora.getFullYear()}`.replace(
              /^./,
              (c) => c.toUpperCase(),
            )}
          </div>
          <div className="jv-ola-msg">
            {saudacao}, {primeiro(eu.nome)}.
          </div>
        </div>
      </div>
      <Ponte eu={eu} />
      <section className="jv-painel">
        <div className="jv-painel-topo">
          <div>
            <h2>Instalar o Jarvis</h2>
            <p className="jv-mudo">
              Baixe o Jarvis Launcher, entre com esta conta e ele instala o
              Jarvis. As atualizações aparecem lá, e ele baixa só o que mudou.
            </p>
          </div>
        </div>
        <div className="jv-corpo jv-instalar">
          <div className="jv-instalar-principal">
            <span className="jv-quad">
              <s.icone />
            </span>
            <div>
              <b>Jarvis Launcher para {s.nome}</b>
              <small>
                {pronto
                  ? s.dica
                  : "A primeira versão está sendo preparada. Volte em alguns minutos."}
              </small>
            </div>
            {pronto ? (
              <a className="jv-btn primario" href={`/api/site/baixar/${sis}`}>
                <Download size={16} /> Baixar
              </a>
            ) : (
              <Selo tom="aviso">Em preparo</Selo>
            )}
          </div>
          <ol className="jv-passos">
            <li>
              <b>Baixe e abra o launcher.</b> {s.aviso}
            </li>
            <li>
              <b>Entre com o seu e-mail e a sua senha.</b> Ele instala o Jarvis
              e o liga à sua conta.
            </li>
            <li>
              <b>Ligue o Telegram</b> para falar com o Jarvis pelo celular.{" "}
              <button className="jv-link" onClick={() => ir("telegram")}>
                Ligar agora
              </button>
            </li>
          </ol>
          <div className="jv-outros">
            <span className="jv-mudo">Outros sistemas:</span>
            {SISTEMAS.filter((x) => x.id !== sis).map((x) =>
              eu.launcher[x.id] ? (
                <a key={x.id} href={`/api/site/baixar/${x.id}`}>
                  <x.icone size={14} /> {x.nome}
                </a>
              ) : (
                <span key={x.id} className="jv-mudo">
                  <x.icone size={14} /> {x.nome} (em preparo)
                </span>
              ),
            )}
          </div>
        </div>
      </section>
      {eu.dispositivos.length > 0 && (
        <section className="jv-painel">
          <div className="jv-painel-topo">
            <h2>Seus computadores</h2>
          </div>
          <Dispositivos lista={eu.dispositivos} />
        </section>
      )}
    </>
  );
}

function Dispositivos({ lista }: { lista: Disp[] }) {
  return (
    <div className="jv-lista">
      {lista.map((d) => (
        <div key={d.id} className="jv-linha">
          <span className="jv-quad pequeno">
            {d.sistema === "mac" ? <Apple /> : <Monitor />}
          </span>
          <div className="jv-linha-titulo">
            {d.nome || nomeSistema(d.sistema)}
            <small>
              {nomeSistema(d.sistema)} · Jarvis {d.jarvis ?? "—"} · launcher{" "}
              {d.launcher ?? "—"}
            </small>
          </div>
          <small className="jv-mudo">visto {d.visto ?? "—"}</small>
        </div>
      ))}
    </div>
  );
}

function TelegramPagina({ eu }: { eu: Eu }) {
  const [link, setLink] = useState<string | null>(null);
  const [codigo, setCodigo] = useState<string | null>(null);
  const [indo, setIndo] = useState(false);
  const [erro, setErro] = useState("");
  const abrir = async () => {
    setIndo(true);
    setErro("");
    try {
      const r = await chamar<{ link: string | null; codigo: string }>(
        "/api/site/telegram",
        "POST",
      );
      setCodigo(r.codigo);
      if (r.link) {
        setLink(r.link);
        window.open(r.link, "_blank", "noopener");
      }
    } catch (x) {
      setErro((x as Error).message);
    } finally {
      setIndo(false);
    }
  };
  return (
    <>
      <Cabecalho
        titulo="Telegram"
        desc="Fale com o seu Jarvis pelo celular: texto, áudio, foto de nota fiscal ou de Pix, extrato e relatórios."
      />
      <section className="jv-painel">
        {!eu.robo ? (
          <Vazio
            icone={<Send />}
            titulo="O robô ainda não foi configurado"
            desc="Quem administra o Jarvis liga o robô do Telegram. Assim que estiver no ar, o botão aparece aqui."
          />
        ) : eu.telegram_ligado ? (
          <>
            <div className="jv-faixa">
              <span className="jv-quad bom">
                <Check />
              </span>
              <div>
                <b>Ligado a @{eu.robo}</b>
                <p className="jv-mudo">
                  É o seu Jarvis, com o seu financeiro e a sua memória. Abra a
                  conversa quando quiser.
                </p>
              </div>
              <a
                className="jv-btn secundario"
                href={`https://t.me/${eu.robo}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Abrir conversa
              </a>
            </div>
            <div className="jv-corpo jv-borda-topo">
              <p className="jv-mudo">
                Trocou de Telegram ou o robô não reconhece você? Gere um código
                e mande para @{eu.robo}.
              </p>
              {codigo ? (
                <Codigo codigo={codigo} robo={eu.robo} link={link} />
              ) : (
                <Botao
                  tipo="secundario"
                  carregando={indo}
                  onClick={abrir}
                  icone={<RefreshCw size={15} />}
                >
                  Ligar de novo
                </Botao>
              )}
            </div>
          </>
        ) : (
          <div className="jv-faixa">
            <span className="jv-quad">
              <Send />
            </span>
            <div>
              <b>Ligue o Telegram a esta conta</b>
              <p className="jv-mudo">
                Toque no botão: o Telegram abre @{eu.robo} e a conversa fica
                ligada à sua conta.
              </p>
              {codigo && <Codigo codigo={codigo} robo={eu.robo} link={link} />}
              <Erro texto={erro} />
            </div>
            <Botao
              tipo="primario"
              carregando={indo}
              onClick={abrir}
              icone={<Send size={16} />}
            >
              Abrir no Telegram
            </Botao>
          </div>
        )}
      </section>
      <section className="jv-painel">
        <div className="jv-painel-topo">
          <h2>Com o computador desligado</h2>
        </div>
        <div className="jv-corpo">
          {eu.bolso?.pronto ? (
            <p>
              O Jarvis de bolso está pronto e responde com a cópia de{" "}
              <b>{horaDe(eu.bolso.copia_em)}</b>. Pergunte do financeiro, peça o
              relatório, lance gastos e entradas. O que você lançar entra no
              financeiro quando o computador ligar, e chega um aviso
              “Sincronizado”.
            </p>
          ) : (
            <p className="jv-mudo">
              Quando o Jarvis do seu computador estiver ligado à conta, ele
              deixa aqui uma cópia cifrada do financeiro e da memória, e o
              Telegram passa a responder mesmo com o computador desligado. Dá
              para desligar isso no painel do Jarvis, em Conexões → Sua conta.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function Codigo({
  codigo,
  robo,
  link,
}: {
  codigo: string;
  robo?: string;
  link: string | null;
}) {
  return (
    <div className="jv-codigo">
      <span className="jv-rotulo">Seu código (vale 7 dias)</span>
      <b>{codigo}</b>
      <p className="jv-mudo pequeno">
        Se o Telegram só abriu a conversa e o robô não respondeu, mande este
        código como mensagem para @{robo}.
        {link && (
          <>
            {" "}
            Ou abra de novo: <a href={link}>{link}</a>
          </>
        )}
      </p>
    </div>
  );
}

function Seguranca({ eu, avisar }: { eu: Eu; avisar: Avisar }) {
  const [atual, setAtual] = useState("");
  const [nova, setNova] = useState("");
  const [nova2, setNova2] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro("");
    if (nova !== nova2) return setErro("As duas senhas novas não são iguais.");
    if (forca(nova).nivel < 2)
      return setErro(
        "Use uma senha mais forte: 12 letras ou mais, ou misture letras, números e símbolos.",
      );
    setIndo(true);
    try {
      await chamar("/api/site/senha", "POST", { atual, nova });
      setAtual("");
      setNova("");
      setNova2("");
      avisar("Senha trocada. Os outros navegadores saíram da conta.");
    } catch (x) {
      setErro((x as Error).message);
    } finally {
      setIndo(false);
    }
  };
  const sairTodos = async () => {
    await chamar("/api/site/sair-de-todos", "POST").catch(() => null);
    location.href = "/site";
  };
  return (
    <>
      <Cabecalho
        titulo="Segurança"
        desc="A senha vale no site e no Jarvis Launcher. Ninguém consegue vê-la, nem o administrador."
      />
      <section className="jv-painel">
        <div className="jv-painel-topo">
          <h2>Trocar a senha</h2>
        </div>
        <form className="jv-form jv-corpo estreito" onSubmit={enviar}>
          <Campo rotulo="Senha atual">
            <Senha valor={atual} mudar={setAtual} />
          </Campo>
          <Campo
            rotulo="Nova senha"
            dica="Pelo menos 8 caracteres. Ao trocar, os outros navegadores saem da conta."
          >
            <Senha valor={nova} mudar={setNova} nova />
          </Campo>
          <Forca senha={nova} />
          <Campo rotulo="Repita a nova senha">
            <Senha valor={nova2} mudar={setNova2} nova />
          </Campo>
          <Erro texto={erro} />
          <div>
            <Botao
              tipo="primario"
              carregando={indo}
              icone={<KeyRound size={16} />}
            >
              Trocar a senha
            </Botao>
          </div>
        </form>
      </section>
      <section className="jv-painel">
        <div className="jv-faixa">
          <span className="jv-quad">
            <ShieldCheck />
          </span>
          <div>
            <b>Navegadores com a conta aberta: {eu.sessoes ?? 1}</b>
            <p className="jv-mudo">
              Esqueceu a conta aberta em outro computador? Saia de todos de uma
              vez (inclusive deste).
            </p>
          </div>
          <Botao
            tipo="secundario"
            onClick={sairTodos}
            icone={<LogOut size={16} />}
          >
            Sair de todos
          </Botao>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- administração

function situacao(c: Conta) {
  if (!c.ativa) return <Selo tom="perigo">Pausada</Selo>;
  if (!c.senha_definida) return <Selo tom="aviso">Convite pendente</Selo>;
  return <Selo tom="bom">{c.admin ? "Administrador" : "Ativa"}</Selo>;
}

function Kpi({
  rotulo,
  valor,
  vivo,
}: {
  rotulo: string;
  valor?: number;
  vivo?: boolean;
}) {
  return (
    <div className="jv-kpi">
      <span>
        {vivo && !!valor && <i className="jv-pulso" />}
        {rotulo}
      </span>
      <b>{valor ?? "—"}</b>
    </div>
  );
}

function Contas({ eu, avisar }: { eu: Eu; avisar: Avisar }) {
  const [contas, setContas] = useState<Conta[] | null>(null);
  const [erro, setErro] = useState("");
  const [busca, setBusca] = useState("");
  const [nova, setNova] = useState(false);
  const [aberta, setAberta] = useState<string | null>(null);
  const carregar = useCallback(() => {
    chamar<Conta[]>("/api/site/admin/contas")
      .then((c) => {
        setContas(c);
        setErro("");
      })
      .catch((e: Error) => setErro(e.message));
  }, []);
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 20000);
    return () => clearInterval(t);
  }, [carregar]);
  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase();
    return (contas ?? [])
      .filter(
        (c) => !b || c.nome.toLowerCase().includes(b) || c.email.includes(b),
      )
      .sort(
        (a, z) =>
          Number(z.admin) - Number(a.admin) || a.nome.localeCompare(z.nome),
      );
  }, [contas, busca]);
  const conta = contas?.find((c) => c.id === aberta);
  return (
    <>
      <Cabecalho
        titulo="Contas"
        desc="Cada pessoa tem o Jarvis no próprio computador. Aqui você vê quem usa, onde e qual versão, nunca os dados de ninguém."
      >
        <Botao
          tipo="primario"
          pilula
          icone={<Plus size={16} />}
          onClick={() => setNova(true)}
        >
          Nova conta
        </Botao>
      </Cabecalho>
      <div className="jv-kpis">
        <Kpi rotulo="Contas" valor={contas?.length} />
        <Kpi rotulo="Ativas" valor={contas?.filter((c) => c.ativa).length} />
        <Kpi
          rotulo="Jarvis ligados agora"
          valor={contas?.filter((c) => c.conectado).length}
          vivo
        />
        <Kpi
          rotulo="Com Telegram"
          valor={contas?.filter((c) => c.telegram_ligado).length}
        />
      </div>
      <section className="jv-painel">
        <div className="jv-painel-topo">
          <label className="jv-busca">
            <Search size={15} />
            <input
              placeholder="Buscar por nome ou e-mail"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              aria-label="Buscar contas"
            />
          </label>
          <button
            className="jv-icone"
            onClick={carregar}
            aria-label="Atualizar"
            title="Atualizar"
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {erro && (
          <div className="jv-corpo">
            <Erro texto={erro} />
          </div>
        )}
        {!contas && !erro && (
          <div className="jv-corpo">
            <div className="jv-esqueleto" />
            <div className="jv-esqueleto" />
          </div>
        )}
        {contas && (
          <div className="jv-tabela" role="table" aria-label="Contas">
            <div className="jv-tabela-cab" role="row">
              <span>Pessoa</span>
              <span>Situação</span>
              <span>Jarvis</span>
              <span>Telegram</span>
              <span>Último uso</span>
              <span />
            </div>
            {filtradas.map((c) => (
              <div
                key={c.id}
                className="jv-tabela-linha"
                role="row"
                onClick={() => setAberta(c.id)}
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && setAberta(c.id)}
              >
                <span className="jv-pessoa">
                  <span className="jv-av" style={cor(c.email)}>
                    {iniciais(c.nome)}
                  </span>
                  <span>
                    <b>
                      {c.nome}{" "}
                      {c.id === eu.id && <em className="jv-mudo">(você)</em>}
                    </b>
                    <small>{c.email}</small>
                  </span>
                </span>
                <span data-rotulo="Situação">{situacao(c)}</span>
                <span data-rotulo="Jarvis">
                  {c.conectado ? (
                    <Selo tom="bom">Ligado</Selo>
                  ) : c.dispositivos.length ? (
                    <span className="jv-mudo">
                      {c.dispositivos.length}{" "}
                      {c.dispositivos.length === 1
                        ? "computador"
                        : "computadores"}
                    </span>
                  ) : (
                    <span className="jv-mudo">Não instalado</span>
                  )}
                </span>
                <span data-rotulo="Telegram" className="jv-mudo">
                  {c.telegram_ligado
                    ? c.bolso
                      ? "Ligado · de bolso"
                      : "Ligado"
                    : "—"}
                </span>
                <span data-rotulo="Último uso" className="jv-mudo">
                  {c.ultimo_uso ?? "—"}
                </span>
                <span className="jv-mais">
                  <MoreHorizontal size={16} />
                </span>
              </div>
            ))}
            {filtradas.length === 0 && (
              <Vazio
                icone={<Users />}
                titulo="Nenhuma conta encontrada"
                desc="Tente outro nome ou e-mail."
              />
            )}
          </div>
        )}
      </section>
      {nova && (
        <NovaConta
          fechar={() => setNova(false)}
          criada={(nome) => {
            avisar(`Conta criada para ${primeiro(nome)}`);
            carregar();
          }}
        />
      )}
      {conta && (
        <DetalheConta
          conta={conta}
          eu={eu}
          fechar={() => setAberta(null)}
          avisar={avisar}
          mudou={carregar}
        />
      )}
    </>
  );
}

function LinkConvite({
  nome,
  link,
  avisar,
}: {
  nome: string;
  link: string;
  avisar?: Avisar;
}) {
  const [copiado, setCopiado] = useState(false);
  const copiar = async () => {
    await navigator.clipboard.writeText(link);
    setCopiado(true);
    avisar?.("Link copiado");
    setTimeout(() => setCopiado(false), 2000);
  };
  const msg = encodeURIComponent(
    `Olá, ${primeiro(nome)}! Seu acesso ao Jarvis está pronto. Crie sua senha por este link (vale 7 dias): ${link}`,
  );
  return (
    <div className="jv-convite">
      <span className="jv-rotulo">
        Link de primeiro acesso (vale 7 dias e uma vez só)
      </span>
      <div className="jv-convite-link">
        <code>{link}</code>
        <Botao
          type="button"
          tipo="secundario"
          onClick={copiar}
          icone={copiado ? <Check size={15} /> : <Copy size={15} />}
        >
          {copiado ? "Copiado" : "Copiar"}
        </Botao>
      </div>
      <a
        className="jv-link"
        href={`https://wa.me/?text=${msg}`}
        target="_blank"
        rel="noopener noreferrer"
      >
        Mandar pelo WhatsApp
      </a>
    </div>
  );
}

function NovaConta({
  fechar,
  criada,
}: {
  fechar: () => void;
  criada: (nome: string) => void;
}) {
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro("");
    setIndo(true);
    try {
      const r = await chamar<{ link: string }>(
        "/api/site/admin/contas",
        "POST",
        { nome: nome.trim(), email: email.trim() },
      );
      setLink(
        r.link.startsWith("http") ? r.link : `${location.origin}${r.link}`,
      );
      criada(nome);
    } catch (x) {
      setErro((x as Error).message);
    } finally {
      setIndo(false);
    }
  };
  return (
    <Janela
      titulo={link ? `Conta criada para ${primeiro(nome)}` : "Nova conta"}
      desc={
        link
          ? "Mande o link para a pessoa criar a senha."
          : "A pessoa recebe um link para criar a senha. Depois ela entra no site e no launcher."
      }
      fechar={fechar}
    >
      {link ? (
        <div className="jv-corpo">
          <LinkConvite nome={nome} link={link} />
          <div className="jv-janela-acoes">
            <Botao tipo="primario" onClick={fechar}>
              Concluir
            </Botao>
          </div>
        </div>
      ) : (
        <form className="jv-form jv-corpo" onSubmit={enviar}>
          <Campo rotulo="Nome">
            <input
              className="jv-input"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="Ana Souza"
              required
              autoFocus
            />
          </Campo>
          <Campo rotulo="E-mail">
            <input
              className="jv-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ana@exemplo.com"
              required
            />
          </Campo>
          <Erro texto={erro} />
          <div className="jv-janela-acoes">
            <Botao type="button" tipo="fantasma" onClick={fechar}>
              Cancelar
            </Botao>
            <Botao tipo="primario" carregando={indo} icone={<Plus size={16} />}>
              Criar conta
            </Botao>
          </div>
        </form>
      )}
    </Janela>
  );
}

function DetalheConta({
  conta,
  eu,
  fechar,
  avisar,
  mudou,
}: {
  conta: Conta;
  eu: Eu;
  fechar: () => void;
  avisar: Avisar;
  mudou: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [apagar, setApagar] = useState(false);
  const [indo, setIndo] = useState<string | null>(null);
  const voce = conta.id === eu.id;
  const fazer = async (
    qual: string,
    fn: () => Promise<unknown>,
    ok: string,
  ) => {
    setIndo(qual);
    try {
      await fn();
      avisar(ok);
      mudou();
    } catch (x) {
      avisar((x as Error).message, true);
    } finally {
      setIndo(null);
    }
  };
  useEffect(() => {
    const tecla = (e: KeyboardEvent) =>
      e.key === "Escape" && !apagar && fechar();
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [fechar, apagar]);
  return (
    <>
      <div
        className="jv-fundo lateral"
        onMouseDown={(e) => e.target === e.currentTarget && fechar()}
      >
        <aside
          className="jv-gaveta"
          role="dialog"
          aria-modal="true"
          aria-label={conta.nome}
        >
          <header>
            <span className="jv-av grande" style={cor(conta.email)}>
              {iniciais(conta.nome)}
            </span>
            <div>
              <h2>{conta.nome}</h2>
              <p className="jv-mudo">{conta.email}</p>
            </div>
            <button className="jv-icone" onClick={fechar} aria-label="Fechar">
              <X size={16} />
            </button>
          </header>
          <div className="jv-gaveta-corpo">
            <dl className="jv-dados">
              <dt>Situação</dt>
              <dd>{situacao(conta)}</dd>
              <dt>Desde</dt>
              <dd>{conta.criado ?? "—"}</dd>
              <dt>Último uso</dt>
              <dd>{conta.ultimo_uso ?? "—"}</dd>
              <dt>Jarvis</dt>
              <dd>
                {conta.conectado ? (
                  <Selo tom="bom">Ligado agora</Selo>
                ) : conta.dispositivos.length ? (
                  "Desligado"
                ) : (
                  "Ainda não instalou"
                )}
              </dd>
              <dt>Telegram</dt>
              <dd>
                {conta.telegram_ligado
                  ? conta.bolso
                    ? "Ligado, com o Jarvis de bolso"
                    : "Ligado"
                  : "Não ligado"}
              </dd>
            </dl>
            <h3>Computadores</h3>
            {conta.dispositivos.length ? (
              <Dispositivos lista={conta.dispositivos} />
            ) : (
              <p className="jv-mudo">
                Nenhum ainda. Aparece aqui quando a pessoa entrar pelo launcher.
              </p>
            )}
            {link && (
              <LinkConvite nome={conta.nome} link={link} avisar={avisar} />
            )}
          </div>
          {!voce && (
            <footer>
              {!conta.senha_definida && (
                <Botao
                  tipo="secundario"
                  carregando={indo === "link"}
                  icone={<RefreshCw size={15} />}
                  onClick={() =>
                    fazer(
                      "link",
                      async () => {
                        const r = await chamar<{ link: string }>(
                          `/api/site/admin/contas/${conta.id}/link`,
                          "POST",
                        );
                        setLink(
                          r.link.startsWith("http")
                            ? r.link
                            : `${location.origin}${r.link}`,
                        );
                      },
                      "Link novo gerado (o anterior deixou de valer)",
                    )
                  }
                >
                  Novo link
                </Botao>
              )}
              <Botao
                tipo="secundario"
                carregando={indo === "pausa"}
                icone={conta.ativa ? <Pause size={15} /> : <Play size={15} />}
                onClick={() =>
                  fazer(
                    "pausa",
                    () =>
                      chamar(
                        `/api/site/admin/contas/${conta.id}/${conta.ativa ? "pausar" : "ativar"}`,
                        "POST",
                      ),
                    conta.ativa ? "Conta pausada" : "Conta ativada",
                  )
                }
              >
                {conta.ativa ? "Pausar" : "Ativar"}
              </Botao>
              <Botao
                tipo="perigo"
                icone={<Trash2 size={15} />}
                onClick={() => setApagar(true)}
              >
                Apagar
              </Botao>
            </footer>
          )}
        </aside>
      </div>
      {apagar && (
        <ApagarConta
          conta={conta}
          fechar={() => setApagar(false)}
          apagada={() => {
            avisar(`Conta de ${primeiro(conta.nome)} apagada`);
            mudou();
            fechar();
          }}
        />
      )}
    </>
  );
}

function ApagarConta({
  conta,
  fechar,
  apagada,
}: {
  conta: Conta;
  fechar: () => void;
  apagada: () => void;
}) {
  const [email, setEmail] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const confere = email.trim().toLowerCase() === conta.email.toLowerCase();
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setIndo(true);
    try {
      await chamar(`/api/site/admin/contas/${conta.id}`, "DELETE", {
        confirmar_email: email.trim(),
      });
      apagada();
    } catch (x) {
      setErro((x as Error).message);
      setIndo(false);
    }
  };
  return (
    <Janela
      titulo={`Apagar a conta de ${primeiro(conta.nome)}?`}
      fechar={fechar}
      largura={460}
    >
      <form className="jv-form jv-corpo" onSubmit={enviar}>
        <p className="jv-mudo">
          A pessoa perde o acesso ao site, ao launcher e ao Telegram. Os dados
          no computador dela não são tocados. O registro da conta fica guardado
          por 30 dias.
        </p>
        <Campo rotulo={`Para confirmar, digite ${conta.email}`}>
          <input
            className="jv-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            autoFocus
          />
        </Campo>
        <Erro texto={erro} />
        <div className="jv-janela-acoes">
          <Botao type="button" tipo="fantasma" onClick={fechar}>
            Cancelar
          </Botao>
          <Botao
            tipo="perigo"
            disabled={!confere}
            carregando={indo}
            icone={<Trash2 size={15} />}
          >
            Apagar conta
          </Botao>
        </div>
      </form>
    </Janela>
  );
}

function Robo({
  eu,
  avisar,
  recarregar,
}: {
  eu: Eu;
  avisar: Avisar;
  recarregar: () => void;
}) {
  const [token, setToken] = useState("");
  const [erro, setErro] = useState("");
  const [indo, setIndo] = useState(false);
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setErro("");
    setIndo(true);
    try {
      const r = await chamar<{ ok: boolean; erro?: string }>(
        "/api/site/admin/telegram",
        "PUT",
        { token: token.trim() },
      );
      if (!r.ok) throw new Error(r.erro || "Não deu certo");
      setToken("");
      avisar("Robô configurado");
      recarregar();
    } catch (x) {
      setErro((x as Error).message);
    } finally {
      setIndo(false);
    }
  };
  return (
    <>
      <Cabecalho
        titulo="Robô do Telegram"
        desc="Um robô para todas as contas. Cada pessoa liga o Telegram dela pelo código da própria conta, e cada conversa só fala com o Jarvis daquela pessoa."
      />
      <section className="jv-painel">
        <div className="jv-faixa">
          <span className={`jv-quad ${eu.robo ? "bom" : ""}`}>
            {eu.robo ? <Check /> : <Send />}
          </span>
          <div>
            <b>{eu.robo ? `@${eu.robo} no ar` : "Nenhum robô configurado"}</b>
            <p className="jv-mudo">
              {eu.robo
                ? "Recebendo mensagens pelo endereço seguro da portaria."
                : "Crie um robô no @BotFather (/newbot) e cole o token abaixo."}
            </p>
          </div>
        </div>
        <form className="jv-form jv-corpo estreito" onSubmit={enviar}>
          <Campo
            rotulo={eu.robo ? "Trocar o token" : "Token do @BotFather"}
            dica="O token fica só no servidor; os computadores das pessoas nunca o recebem."
          >
            <Senha valor={token} mudar={setToken} placeholder="123456789:AA…" />
          </Campo>
          <Erro texto={erro} />
          <div>
            <Botao tipo="primario" carregando={indo}>
              {eu.robo ? "Trocar o robô" : "Salvar"}
            </Botao>
          </div>
        </form>
      </section>
    </>
  );
}

function Versoes() {
  const [v, setV] = useState<Record<string, Record<string, Versao[]>> | null>(
    null,
  );
  const [erro, setErro] = useState("");
  useEffect(() => {
    chamar("/api/site/admin/versoes")
      .then(setV)
      .catch((e: Error) => setErro(e.message));
  }, []);
  return (
    <>
      <Cabecalho
        titulo="Versões"
        desc="O que a compilação automática publicou na loja. O launcher de cada pessoa mostra a versão nova e baixa só o que mudou."
      />
      <Erro texto={erro} />
      <div className="jv-grade3">
        {SISTEMAS.map((s) => {
          const jv = v?.jarvis?.[s.id] ?? [];
          const la = v?.launcher?.[s.id] ?? [];
          const ins = v?.instalador?.[s.id] ?? [];
          return (
            <section key={s.id} className="jv-painel">
              <div className="jv-painel-topo">
                <h2 className="jv-com-icone">
                  <s.icone size={16} /> {s.nome}
                </h2>
              </div>
              <div className="jv-corpo">
                {!v ? (
                  <div className="jv-esqueleto" />
                ) : !jv.length && !la.length ? (
                  <p className="jv-mudo">Nada publicado ainda.</p>
                ) : (
                  <dl className="jv-dados">
                    <dt>Jarvis</dt>
                    <dd>{jv[0] ? `${jv[0].versao} · ${jv[0].data}` : "—"}</dd>
                    <dt>Launcher</dt>
                    <dd>{la[0] ? `${la[0].versao} · ${la[0].data}` : "—"}</dd>
                    <dt>Instalador</dt>
                    <dd>
                      {ins[0] ? `${ins[0].versao} · ${ins[0].data}` : "—"}
                    </dd>
                    {jv.length > 1 && (
                      <>
                        <dt>Anteriores</dt>
                        <dd>
                          {jv
                            .slice(1, 4)
                            .map((x) => x.versao)
                            .join(", ")}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
