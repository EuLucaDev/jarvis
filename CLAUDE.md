# J.A.R.V.I.S.

Assistente de voz pessoal do Luca, rodando no Mac (`localhost:8000`). Recriação do sistema visto em vídeos de referência: esfera de voz no monitor principal, cartões projetados durante a resposta, briefing de "bom dia", telas extras com widgets.

## Como rodar

```bash
cd frontend && npm install && npm run build      # gera frontend/dist
uv run --directory backend uvicorn jarvis.app:app --port 8000
```

Abrir `http://localhost:8000` no Chrome (o microfone precisa de permissão do navegador). Desenvolvimento com recarga: backend como acima e `npm --prefix frontend run dev` (porta 5173, repassa `/ws` e `/api` ao backend). Configuração em `.env` (modelo em `.env.example`); nunca commitar `.env` nem `data/`.

## Arquitetura

- `backend/jarvis/app.py`: FastAPI. `/ws` é o barramento único: JSON para eventos, frames binários para áudio. Serve `frontend/dist`.
- `backend/jarvis/live.py`: `VoiceBridge` liga o microfone do navegador (PCM 16 kHz) à Gemini Live (`gemini-3.8-live`) e devolve áudio de 24 kHz. Reconecta com retomada de sessão; compressão de contexto ligada.
- `backend/jarvis/tools.py`: ferramentas chamadas pelo modelo. Cada uma projeta um cartão pelo `hub`.
- `backend/jarvis/hub.py`: estado compartilhado por todas as telas (status, cartões).
- `backend/jarvis/memory.py`: memória de longo prazo (ver abaixo).
- `frontend/src/hud/`: HUD (esfera em canvas, legenda, cartões, controles). `useJarvis.ts` decide a fase (espera/ouvindo/pensando/falando) a cada quadro.

### Limites do plano gratuito da Gemini (testado em 21/10/2026)

- A busca embutida do Google (`google_search`) tem cota zero no gratuito, tanto na Live 3.x quanto nos modelos de texto. Por isso a pesquisa é uma ferramenta própria (`pesquisar_web`): DuckDuckGo para busca geral e RSS do Google Notícias para notícias. Com faturamento ativo, `JARVIS_SEARCH=google` volta à busca embutida.
- Texto (`gemini-3.8-flash`, `gemini-3.5-flash-lite`) e embeddings (`gemini-embedding-001`) são gratuitos. O `gemini-3.8-flash` às vezes responde 503; a memória cai para o lite.

### Memória

SQLite local em `data/jarvis.db`, sem custo. Tipos: perfil, preferencia, correcao, licao, nota. Cada memória tem embedding de 768 dimensões para busca por sentido; memórias quase iguais (cosseno ≥ 0,9) são atualizadas em vez de duplicadas. As conversas são registradas por sessão e, ao fim de cada sessão, `reflect()` usa um modelo de texto para extrair fatos, preferências, correções e lições. O bloco de memórias entra no prompt da próxima sessão. Ferramentas de voz: `lembrar`, `buscar_memorias`, `esquecer`. API: `GET /api/memorias`, `DELETE /api/memorias/{id}`.

## Visual

Linguagem do vídeo (azul-noite, esfera de fitas luminosas, rótulos de estado em mono espaçado, cartões translúcidos com borda clara) sobre a arquitetura de camadas da skill `estilo-workflow`. O painel administrativo (Fase 4) segue `estilo-workflow` e as regras de app da `design-taste-frontend`.

## Fases

| Fase | Entrega | Estado |
|---|---|---|
| 0 | Base: backend, WebSocket, HUD | feito |
| 1 | Esfera e voz (Gemini Live, 4 estados, legenda) | feito |
| 2 | Cartões dinâmicos (pesquisa, clima, lista) + pesquisa grátis | feito |
| 2b | Memória de longo prazo que aprende | feito |
| 3 | Briefing "bom dia": Gmail (IMAP + senha de app), Google Agenda (iCal), notícias por tema com imagem, clima; roteiro falado com deixas de cartão | próximo |
| 4 | Painel admin (`/admin`): chat, briefing, fontes de dados, memórias, logs, configurações | |
| 5 | Telas extras (`/tela/:id`): bloqueio/desbloqueio por voz, editor de widgets, sincronização | |
| 6 | Integrações pedidas pelo Luca: controle do computador (atalhos, apps, AppleScript), celular, Alexa, câmeras; palavra de ativação "Jarvis"; telemetria do Mac | |

## Convenções

- Textos de interface em português do Brasil, sentence case.
- Nunca inventar dados nos cartões; demonstração usa dados marcados como exemplo.
- Microfone mudo enquanto o Jarvis fala, a menos que "Interromper falando" esteja ligado (com fone).
