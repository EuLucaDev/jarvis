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
- `backend/jarvis/briefing.py` + `sources/` (gmail IMAP, agenda iCal, notícias): monta o "bom dia" e o roteiro falado em segmentos; cada segmento tem um cartão. Fica pré-montado em segundo plano (`refresh_loop`).
- `backend/jarvis/system.py`: telemetria (psutil), controle do computador por lista fechada (abrir app/link, mídia, volume, Atalhos liberados) e câmeras (RTSP via ffmpeg ou foto HTTP).
- `backend/jarvis/store.py`: ajustes editáveis pelo painel (tabela `ajustes` no mesmo SQLite). Senhas de app nunca voltam ao navegador.
- `backend/jarvis/chat.py`: chat por texto do painel com as mesmas ferramentas.
- `frontend/src/hud/`: HUD (esfera em canvas, legenda, cartões, controles). `useJarvis.ts` decide a fase (espera/ouvindo/pensando/falando) a cada quadro, solta a legenda no relógio do áudio e pede os cartões do briefing pela contagem de palavras faladas (`sequence.plan` → `sequence.show`).
- `frontend/src/tela/`: telas extras `/tela/<id>` (bloqueio compartilhado, widgets, Personalizar tela).
- `frontend/src/admin/`: painel `/admin/<página>` no estilo WorkFlow.
- `frontend/src/lib/wake.ts`: palavra de ativação "Jarvis" pelo reconhecimento de fala do Chrome.
- `frontend/src/lib/face.ts` + `hud/Presence.tsx`: reconhecimento facial local com face-api (modelos em `frontend/public/models`); descritores salvos em `ajustes.rosto`.
- `backend/jarvis/market.py`: cotações grátis do Yahoo Finance.

### Segurança das ações

Ações destrutivas (`arquivos` → organizar, lixeira) exigem `confirmado=true` numa segunda chamada, depois do sim do usuário. Arquivos só dentro da pasta pessoal; lixeira usa a Lixeira do Finder (recuperável). Sem execução de comando livre.

### Sincronia fala × legenda × cartões

A Gemini gera texto e áudio mais rápido que a reprodução. Cada pedaço de transcrição é marcado com o instante do áudio já agendado quando chegou e só aparece quando o relógio do `AudioContext` passa por ele. No briefing, o backend manda ao HUD os deslocamentos em palavras de cada cartão; o HUD pede o cartão quando a legenda chega lá. Rede de segurança no backend mostra o que faltar depois da fala.

### Limites do plano gratuito da Gemini (testado em 21/10/2026)

- A busca embutida do Google (`google_search`) tem cota zero no gratuito, tanto na Live 3.x quanto nos modelos de texto. Por isso a pesquisa é uma ferramenta própria (`pesquisar_web`): DuckDuckGo para busca geral e RSS do Google Notícias para notícias. Com faturamento ativo, `JARVIS_SEARCH=google` volta à busca embutida.
- Texto (`gemini-3.8-flash`, `gemini-3.5-flash-lite`) e embeddings (`gemini-embedding-001`) são gratuitos. O `gemini-3.8-flash` às vezes responde 503; a memória cai para o lite.

### Memória

SQLite local em `data/jarvis.db`, sem custo. Tipos: perfil, preferencia, correcao, licao, nota. Cada memória tem embedding de 768 dimensões para busca por sentido; memórias quase iguais (cosseno ≥ 0,9) são atualizadas em vez de duplicadas. As conversas são registradas por sessão e, ao fim de cada sessão, `reflect()` usa um modelo de texto para extrair fatos, preferências, correções e lições. O bloco de memórias entra no prompt da próxima sessão. Ferramentas de voz: `lembrar`, `buscar_memorias`, `esquecer`. API: `GET /api/memorias`, `DELETE /api/memorias/{id}`.

## Visual

Segue o Jarvis de referência (`docs/referencia-lucas-victor.md`): azul-noite, acento ciano, Space Grotesk / Manrope / JetBrains Mono, painéis com borda ciano e brilho. HUD em três colunas (sinal, espectro, leitura e serviços à esquerda; esfera no centro; clima e canal de conversa à direita), barras superior e inferior iguais às do monitor de referência, e "Gerenciar HUD" para mover/esconder painéis. Telas extras com abas de visões (Centro de comando, Agenda tática, Comunicações, Radar, Núcleo). O painel usa a mesma linguagem sobre a arquitetura de camadas da skill `estilo-workflow`.

## Fases

| Fase | Entrega | Estado |
|---|---|---|
| 0 | Base: backend, WebSocket, HUD | feito |
| 1 | Esfera e voz (Gemini Live, 4 estados, legenda) | feito |
| 2 | Cartões dinâmicos (pesquisa, clima, lista) + pesquisa grátis | feito |
| 2b | Memória de longo prazo que aprende | feito |
| 3 | Briefing "bom dia": Gmail (IMAP + senha de app), Google Agenda (iCal), notícias por tema com imagem, clima; roteiro falado com cartões sincronizados | feito (Gmail/Agenda aguardam credenciais do Luca para teste real) |
| 4 | Painel admin (`/admin`): chat, briefing, fontes de dados, memórias, conversas, telas, integrações, sistema/logs | feito |
| 5 | Telas extras (`/tela/:id`): bloqueio/desbloqueio por voz ("ativar monitores"), widgets, Personalizar tela, sincronização | feito |
| 6 | Computador (apps, sites, mídia, volume), Atalhos do macOS como ponte para celular/HomeKit/Alexa, câmeras, palavra de ativação, telemetria | feito; falta o Luca criar/liberar Atalhos e cadastrar câmeras |
| 7 | Mescla com o Jarvis de referência: HUD em 3 colunas, telas com abas, Conexões em grade, Financeiro (Yahoo Finance), Alexa (Voice Monkey), Lembretes da Apple, arquivos com confirmação, brilho/bloqueio, visão (câmera e tela vão para a Gemini), presença com reconhecimento facial local (face-api) e bom dia automático | feito; reconhecimento facial, câmera e Alexa aguardam teste do Luca |
| 8 | Ideias seguintes: saúde (Apple Saúde/WHOOP), Notion/Obsidian, WhatsApp/iMessage, gestos pela câmera, acesso remoto via Coolify, iniciar sozinho com o Mac | |

## Convenções

- Textos de interface em português do Brasil, sentence case.
- Nunca inventar dados nos cartões; demonstração usa dados marcados como exemplo.
- Microfone mudo enquanto o Jarvis fala, a menos que "Interromper falando" esteja ligado (com fone).
