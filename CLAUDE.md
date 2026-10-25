# J.A.R.V.I.S.

Assistente de voz pessoal do Luca, rodando no Mac (`localhost:8000`). Recriação do sistema visto em vídeos de referência: esfera de voz no monitor principal, cartões projetados durante a resposta, briefing de "bom dia", telas extras com widgets.

## Como rodar

Instalado como serviço (`scripts/instalar.sh`): `com.jarvis.servidor` (KeepAlive) e `com.jarvis.telas` (no login abre o HUD via `jarvis/launcher.py`, um perfil de Chrome por monitor em `~/Library/Application Support/Jarvis`; o perfil do HUD tem `--use-fake-ui-for-media-stream` e autoplay liberado). Padrão é uma tela só: sem mapa no painel, abre só o HUD no monitor principal e os outros (inclusive o do notebook) ficam livres; com um monitor só, nada de `--kiosk`. O `index.html` vai sem cache, então recarregar a janela pega o build novo. Para aplicar mudanças: `npm run build` no frontend e `launchctl kickstart -k gui/$(id -u)/com.jarvis.servidor`. Não rode outro uvicorn na porta 8000 enquanto o serviço estiver ativo.

```bash
cd frontend && npm install && npm run build      # gera frontend/dist
uv run --directory backend uvicorn jarvis.app:app --port 8000
```

Abrir `http://localhost:8000` no Chrome (o microfone precisa de permissão do navegador). Desenvolvimento com recarga: backend como acima e `npm --prefix frontend run dev` (porta 5173, repassa `/ws` e `/api` ao backend). Configuração em `.env` (modelo em `.env.example`); nunca commitar `.env` nem `data/`.

### App instalado (`desktop-app/`)

Electron que embrulha o HUD: `scripts/instalar-app.sh` compila e instala em `/Applications/Jarvis.app` (assinatura local ad hoc, sem conta da Apple). Usa o servidor do serviço se estiver no ar; senão sobe o próprio (`JARVIS_APP_CHILD=1`). Cria uma camada transparente por monitor (`/overlay`, clique passa direto) com a esfera mini quando o HUD é minimizado (voz e espectro chegam do HUD pelo `BroadcastChannel('jarvis-live')`) e a esfera que voa até o que o Jarvis olha ou altera (evento `olhar` em pontos globais, vindo de `overlay.look`). Barra de menus, ⌥ Espaço, abre no login, fechar só esconde. Com o app avisando (`/api/app/ping`), o lançador do login não abre mais o HUD no Chrome. Ao testar pelo terminal do VS Code, rode com `env -u ELECTRON_RUN_AS_NODE`.

Estados da janela: visível, minimizado (esfera mini no canto com espectro) e oculto (só o ícone; é como abre no login). O servidor roda dentro do app (o serviço `com.jarvis.servidor` fica desligado com `launchctl disable`), então as permissões do macOS são do "Jarvis"; cada reinstalação da casca (assinatura ad hoc) pede para ligar a Acessibilidade de novo. Ouvido em segundo plano (`listener.py` + `listener_app.py`): "Jarvis" pelo reconhecimento de fala do macOS em pt-BR no aparelho e duas palmas pelo microfone; vira o evento `despertar` (HUD aparece, abertura, bom dia na primeira chamada da manhã). O reconhecimento do Chrome não existe no Electron, por isso o `wake.ts` fica desligado no app. Mãos nas janelas (`windows.py`): com o HUD fora de foco ou minimizado, a mão mira qualquer janela (borda azul na camada), pinça e mexe arrasta, pinça parada entra no ajuste de tamanho (L), segurar na borda joga para o outro monitor, pinça rápida clica de verdade.

Atualização (`backend/jarvis/updater.py`): versão em `VERSION`; procura no remoto git, baixa só por avanço rápido, roda `uv sync` e o build do HUD, reinicia e o HUD toca a animação "Atualizando J.A.R.V.I.S.". Recusa se houver mudança local não salva. Se `desktop-app/` mudou, o app se reinstala sozinho (`instalar-app.sh --reabrir`).

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
- `frontend/src/lib/wake.ts`: palavra de ativação "Jarvis" pelo reconhecimento de fala do Chrome. Bipe ao ouvir "Jarvis"; o resto da frase ("Jarvis, bom dia") vira o pedido em texto.
- `frontend/src/lib/sfx.ts`: efeitos sonoros sintetizados (ouvi, voz no ar, briefing, cartão, desbloqueio, aviso, erro). Só o HUD toca; liga/desliga no rodapé.
- `frontend/src/lib/gestures.ts` + `hud/air.ts`: gestos com até duas mãos. A pinça só conta se ficar firme (~100 ms); mãos pequenas ou com detecção fraca são ignoradas. Pinça e solta clica; pinça e mexe arrasta (cartão para as zonas: esquerda fixa, direita fecha, embaixo guarda; chip para cima; cartão fixo; listas rolam). Pinça **parada** no cartão enche um anel e entra no ajuste: polegar e indicador em L mudam o tamanho (no mercado, o período), ficar parado fixa, mão aberta ou soltar cancela e volta ao tamanho anterior. Duas pinças paradas fazem o mesmo pela distância entre as mãos. Tempo de segurar (1 a 3 s, padrão 2 s) escolhido na prévia dos gestos. Modo mouse: a mão move o mouse do Mac (pinça clica/arrasta, dois dedos rolam, punho sai). O laço roda por timer e o lançador abre o HUD sem frear janela encoberta. Teste sem câmera: `/?air=teste` expõe `window.jarvisAir(quadro)`.
- `frontend/src/hud/Overlays.tsx`: Painéis (widgets das telas dentro do HUD, para quem tem um monitor só; abre por voz com `abrir_painel`), Quadro (desenho por mouse ou pinça no ar, vai como imagem para a Gemini), cursor da mão e lista de tarefas.
- `frontend/src/lib/face.ts` + `hud/Presence.tsx`: reconhecimento facial local com face-api (modelos em `frontend/public/models`); descritores salvos em `ajustes.rosto`.
- `backend/jarvis/market.py`: cotações grátis do Yahoo Finance.
- `backend/jarvis/desktop.py`: controle do Mac à vista (Quartz): digitar, atalhos, navegador (nova aba, busca) e o mouse do modo mouse. Exige Acessibilidade para o Python do serviço (botão em `/admin/operacoes`). Recusa digitar quando a janela da frente é o próprio Jarvis; atalhos que fecham ou apagam pedem confirmação.
- `backend/jarvis/context.py`: o que o Luca está fazendo (app/janela da frente, endereço da aba, texto selecionado pela Acessibilidade ou Cmd+C devolvendo a área de transferência, elemento embaixo do mouse) e clique em botões/links pelo nome (árvore de Acessibilidade; em apps Chromium liga `AXManualAccessibility`). Ferramentas `contexto_atual`, `substituir_selecao`, `clicar`.
- `backend/jarvis/overlay.py` + `overlay_app.py`: cursor próprio do Jarvis (processo AppKit à parte, por cima de tudo, sem receber cliques) com etiqueta da ação; Esc logo depois de uma ação dele vira "parar" (`desktop.cancel`), avisando a sessão de voz.
- `backend/jarvis/activity.py`: memória de trabalho (app/janela/aba na frente a cada 20 s, 7 dias, tabela `atividade`), sugestões discretas no HUD (endereço/link copiado, 45 min na mesma janela) e fim do modo foco a dois (avisos não urgentes ficam em `hub.focus_queue`). `ambient.py`: luz ambiente pela fase, via Voice Monkey, desligada por padrão.
- Plano visível: `mostrar_plano`/`atualizar_plano` (cartão `plano`), `parar`, `onde_parei`, `modo_foco`. No HUD: botão Parar, sugestões (polegar para cima aceita), zona Copiar no alto ao arrastar cartão, "isso aqui" (cartão apontado pela mão vai para `hub.pointed`), esfera acompanha a mão, sons com lado.
- `olhar` (ferramenta): vai até uma região da janela da frente ("barra lateral", cantos) ou um elemento pelo nome, destaca e manda a imagem da área para a Gemini (`screencapture`, exige Gravação de Tela). `janela_jarvis`: minimiza para a esfera do canto ou volta. `/api/olhar` testa a animação.
- `backend/jarvis/protocols.py`: protocolos (rotinas com nome, editadas em `/admin/operacoes`), passos da lista fechada `TIPOS`.
- `backend/jarvis/agents.py`: tarefas para outras IAs do Luca em segundo plano: Claude Code (`claude -p`, sem Bash, com MCPs liberados em `ajustes.agentes`), Codex e ChatGPT (`codex exec` com o login do ChatGPT; o modelo do `~/.codex/config.toml` não vale para essa conta, por isso `codex_modelo`). Cada tarefa tem pasta e repositório git próprios em `~/Jarvis/Tarefas` (a pasta pessoal é um repo e o `git status` travaria o agente). claude/codex exigem confirmação falada.
- Ferramentas lentas (`tools.NON_BLOCKING`, hoje `pesquisar_web`) usam `Behavior.NON_BLOCKING`: ele avisa que vai checar e responde quando chega. Todas as ferramentas rodam numa task à parte, sem travar o laço da sessão.
- `backend/jarvis/alerts.py`: verificação a cada minuto (agenda, e-mails urgentes novos, mercado); avisos no HUD, notificação do Mac e fala; horário de silêncio. Mensagens "[Aviso do sistema…]" entram na sessão de voz para ele anunciar.
- Modelos de visão (rosto e gestos) ficam fora do git: `npm run modelos` copia/baixa para `frontend/public` (o `instalar.sh` já roda).

### Segurança das ações

Ações destrutivas (`arquivos` → organizar, lixeira; atalhos como cmd+q e cmd+delete) exigem `confirmado=true` numa segunda chamada, depois do sim do usuário. Arquivos só dentro da pasta pessoal; lixeira usa a Lixeira do Finder (recuperável). Sem execução de comando livre: o controle do Mac é por teclado e mouse à vista do Luca (`desktop.py`), nunca terminal; o Jarvis não digita senhas nem dados de cartão.

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
| 8 | Iniciar sozinho com o Mac: serviço do servidor, abertura das telas por monitor no login, app Jarvis, painel Monitores | feito |
| 9 | Alertas proativos (`alerts.py`), iMessage (`sources/imessage.py`, exige Acesso Total ao Disco para o Python do serviço), notas Obsidian/Notion (`sources/notes.py`), Apple Saúde por exportação (`sources/health.py`, página Saúde), gestos pela câmera (MediaPipe, `lib/gestures.ts`), filtro da transcrição sem áudio | feito |
| 10 | Uma tela primeiro (layout fluido, Painéis no HUD, launcher sem sequestrar o notebook), esfera maior que não trava, "Jarvis, pedido" de uma vez, sons, frases de etapa, pesquisa sem bloqueio, quadro e pinça no ar, protocolos, tarefas para Claude Code/Codex/ChatGPT | feito; gestos de pinça e palavra de ativação aguardam teste do Luca com câmera e microfone |
| 11 | Pendente de decisão: acesso fora de casa (túnel Cloudflare + login); WhatsApp (sem API grátis confiável) | |

## Convenções

- Textos de interface em português do Brasil, sentence case.
- Nunca inventar dados nos cartões; demonstração usa dados marcados como exemplo.
- Microfone mudo enquanto o Jarvis fala, a menos que "Interromper falando" esteja ligado (com fone).
