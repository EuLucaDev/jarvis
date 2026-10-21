# J.A.R.V.I.S.

Assistente de voz pessoal que roda no seu Mac. Você fala, ele responde em voz e projeta cartões na tela com pesquisas, clima e listas. Ele guarda o que aprende sobre você e melhora a cada conversa.

## Rodar

Precisa de Node 22+, [uv](https://docs.astral.sh/uv/) e uma chave da Gemini API (aistudio.google.com/apikey).

```bash
cp .env.example .env        # cole a chave em GEMINI_API_KEY
cd frontend && npm install && npm run build && cd ..
uv run --directory backend uvicorn jarvis.app:app --port 8000
```

Abra http://localhost:8000 no Chrome, clique no microfone (ou aperte espaço) e permita o acesso ao microfone.

- Sem fone de ouvido, o microfone fica mudo enquanto ele fala, para ele não ouvir a própria voz. Com fone, ligue "Interromper falando".
- Sem chave, o botão "Ver demonstração" mostra os estados e os cartões.
- Sem microfone, dá para conversar pelo campo de texto e ouvir a resposta.

## Ligar sozinho com o Mac

```bash
bash scripts/instalar.sh
```

Cria dois serviços de login (o servidor, que volta sozinho se cair, e a abertura das telas) e o app **Jarvis** em `~/Applications`, que reabre as telas com um clique. No login, o HUD abre em tela cheia no monitor principal e as telas extras nos outros; troque em Painel → Telas → Monitores. Sair da tela cheia: Cmd+Q na janela. Logs em `~/Library/Logs/Jarvis`. Para remover: `bash scripts/desinstalar.sh`.

Depois de mudar o código: `cd frontend && npm run build` e `launchctl kickstart -k gui/$(id -u)/com.jarvis.servidor`.

## O que tem

- **HUD** (`/`): esfera de voz, legenda, cartões de pesquisa, clima, listas, e-mails, agenda, notícias e câmeras.
- **Bom dia**: diga "bom dia" e ele lê o resumo do dia enquanto os cartões entram em sequência.
- **Telas extras** (`/tela/centro`, `/tela/radar`…): abra em outro monitor em tela cheia; "Jarvis, ativar monitores" desbloqueia todas. A engrenagem monta os widgets.
- **Painel** (`/admin`): chat por texto, briefing, fontes de dados (Gmail, agendas, radar), memórias, conversas, telas, integrações e sistema.
- **Computador e casa**: abrir apps e sites, música, volume e Atalhos do macOS liberados no painel (ponte para iPhone, HomeKit e Alexa).
- **Palavra de ativação**: ícone de ouvido no HUD (Chrome).
- **Presença**: cadastre seu rosto em Painel → Presença e ligue o ícone de rosto no HUD. Ele reconhece você, desbloqueia as telas e, de manhã, abre o bom dia sozinho.
- **Visão**: ícones de câmera e de tela no HUD; o Jarvis passa a ver você ou a sua tela durante a conversa.
- **Alexa**: Painel → Conexões → Alexa (precisa de conta grátis no Voice Monkey).
- **Mercado**: "como está o mercado?" e Painel → Financeiro.

## Variáveis

Veja `.env.example`: `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_TEXT_MODEL`, `JARVIS_SEARCH`, `JARVIS_VOICE`, `JARVIS_CITY`, `JARVIS_USER_NAME`, `PORT`.

## Memória

Fica em `data/jarvis.db` (SQLite, local). Para ver o que ele sabe: http://localhost:8000/api/memorias. Por voz: "lembra que…", "o que você sabe sobre…", "esquece que…".
