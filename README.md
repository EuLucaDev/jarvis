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

## O que tem

- **HUD** (`/`): esfera de voz, legenda, cartões de pesquisa, clima, listas, e-mails, agenda, notícias e câmeras.
- **Bom dia**: diga "bom dia" e ele lê o resumo do dia enquanto os cartões entram em sequência.
- **Telas extras** (`/tela/centro`, `/tela/radar`…): abra em outro monitor em tela cheia; "Jarvis, ativar monitores" desbloqueia todas. A engrenagem monta os widgets.
- **Painel** (`/admin`): chat por texto, briefing, fontes de dados (Gmail, agendas, radar), memórias, conversas, telas, integrações e sistema.
- **Computador e casa**: abrir apps e sites, música, volume e Atalhos do macOS liberados no painel (ponte para iPhone, HomeKit e Alexa).
- **Palavra de ativação**: ligue "Ativar com Jarvis" no HUD (Chrome).

## Variáveis

Veja `.env.example`: `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_TEXT_MODEL`, `JARVIS_SEARCH`, `JARVIS_VOICE`, `JARVIS_CITY`, `JARVIS_USER_NAME`, `PORT`.

## Memória

Fica em `data/jarvis.db` (SQLite, local). Para ver o que ele sabe: http://localhost:8000/api/memorias. Por voz: "lembra que…", "o que você sabe sobre…", "esquece que…".
