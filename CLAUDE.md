# J.A.R.V.I.S. 2

Assistente de voz pessoal do Luca para **Mac, Windows e Linux**: esfera Aura, conversa por voz com a Gemini Live, cartões flutuando na área de trabalho, mãos pela câmera como ponteiro da tela inteira, controle do computador à vista e "Jarvis"/palmas para acordar. Entregue como **zip com os três sistemas**, com configuração inicial na primeira vez. O Luca não roda nada à mão: ele extrai, instala e usa. **Não abrir o app no Mac dele para testar** (pedido dele); validar pelo núcleo em modo de teste e pela compilação automática.

## Arquitetura

Três partes, um processo de cada lado da permissão:

| Parte | Pasta | O que faz |
|---|---|---|
| Casca | `app/` (Tauri 2, Rust) | No Mac, se aberto fora de Aplicativos (App Translocation), se copia para lá e reabre. Fechar = ir para o canto (esconde o HUD; a camada mostra a esfera pequena); "esconder" = só o ícone. Refaz o registro de abrir com o computador a cada abertura (desliga pelo menu). Sobe o núcleo (filho dele, então as permissões do macOS ficam com o "Jarvis"), abre o HUD e uma camada transparente por monitor, bandeja/barra de menus, Alt+Espaço, abrir com o computador (escondido). Janelas carregam as páginas do núcleo em `http://127.0.0.1:8765`. |
| Núcleo | `backend/jarvis/` (Python 3.12, empacotado com PyInstaller) | Voz, ouvido, mãos, controle do PC, dados e a API/WebSocket. |
| Interface | `frontend/src/` (React + Vite) | HUD (`/`), camada sobre a tela (`/overlay`), configuração inicial (`/setup`), painel (`/admin`). Servida pelo núcleo. |

### Núcleo (`backend/jarvis/`)
- `config.py`: pasta de dados por sistema (`JARVIS_HOME`, ou `~/Library/Application Support/Jarvis`, `%APPDATA%\Jarvis`, `~/.local/share/jarvis`) e `config.json` (chave da Gemini, nome, tratamento, cidade, voz, câmera). Lê de novo a cada mudança. Produto para qualquer pessoa: nada vem do Jarvis 1 nem do Mac do Luca; cada instalação começa do zero.
- `audio.py`: microfone 16 kHz (sempre aberto, guarda 3 s) e alto-falante 24 kHz (sounddevice), níveis de entrada/saída.
- `live.py`: `voice`, a sessão com a Gemini Live. Raciocínio da voz em `ajustes.voz.raciocinio` (rapido = `gemini-3.8-live`; equilibrado/profundo = `gemini-3.8-live-extended-thinking` com `thinking_level` LOW/HIGH; sem o modelo, volta ao comum). Ferramenta `pensar` (NON_BLOCKING): pedidos difíceis vão para `gemini-pro-latest` (exige faturamento; no grátis a cota é zero) com reserva nos Flash, pausando o modelo conforme o erro (cota zero 6 h, por minuto 1 min). Microfone mudo enquanto ele fala (a menos que `ajustes.voz.interromper`). Legenda sai quando o alto-falante alcança o áudio do pedaço (`legenda`); fase e nível vão às telas (`vivo`, 20/s). Cartões do briefing liberados pela contagem de palavras faladas. Dorme após 45 s quieta.
- `listener.py`: ouvido offline. Vosk pt-BR com gramática `["jarbas","jantar","[unk]"]` ("Jarvis" não está no vocabulário; "Jarbas" soa igual, "jantar" é isca) e confiança ≥ 0,7 no resultado final; a frase inteira vai junto para a Gemini (`audio.recent`). Palmas por pico de energia. Gera `despertar`.
- `hands.py`: câmera + MediaPipe Gesture Recognizer numa thread; manda `maos` (x/y do ponteiro pelos nós do indicador e do médio, que não se mexem na pinça; `ax/ay` = onde estava antes da pinça, onde o clique cai; pinça firme com histerese, abertura, pose) e `gesto` (deslizes e poses paradas). Último quadro em JPEG para a Gemini ver (`camera ver`).
- `pc/`: controle do computador com a mesma interface nos três sistemas (`mac.py` + `mac_*.py` com Quartz/Acessibilidade; `win.py` com Win32/UI Automation/pycaw; `linux.py` com wmctrl/xdotool/xclip, só X11). Janelas: `win_aim/grab/move/scale/throw/release`. Contexto: `snapshot`, `look_at`, `click_named`, seleção.
- `screen.py`: espelho da tela (`espelho`): com ele ligado, a tela principal vai para a Gemini a cada 2 s e para o painel "Visão · Tela" (`/api/tela/ao-vivo`). Ferramenta `espelhar_tela`.
- Janelas dos outros apps por voz: `pc.janela_app(app, acao)` nos três sistemas (minimizar, restaurar, focar, maximizar, tela_cheia, esquerda/direita, outro_monitor, fechar, esconder, sair com confirmação); `common.escolher_app` acha o app pelo que a pessoa disse ("navegador" = o da frente ou o primeiro aberto). Ferramenta `controlar_janela`.
- `web.py`: navegador à vista nos três sistemas (abas, pesquisa por site, `abrir_resultados`, `ler_pagina` por download do endereço ou Cmd+A/Cmd+C devolvendo a área de transferência, localizar, zoom). Traz o navegador à frente antes de teclar.
- Arquivos (`system.py`): criar pasta/arquivo, ler (txt, md, PDF via pypdf, Word/PowerPoint/Excel), listar, abrir, renomear, mover, copiar, compactar, organizar e lixeira (confirmação), sempre dentro da pasta pessoal.
- `gestures.py`: gestos de atalho (poses do MediaPipe e deslizes) → ação escolhida no painel (Gestos), executada no núcleo. A pinça/rolagem/zoom com duas mãos é fixa (`handControl.ts`).
- `protocols.py`: rotinas com passos da lista fechada `TIPOS`, criadas no painel ou por voz (`rotinas`), com horário opcional (`quando`) rodado pelo `loop()`.
- Esfera acompanhando as ações: `tools.run` manda a esfera até a janela da frente (`overlay.at_front`, `pc.front_rect`) antes/depois das ações visíveis (`_ROTULO`) e devolve com `hide_later`. `usar_menu` (Mac) abre menus pelo nome.
- `sistemas.py`: sistemas da pessoa conectados por MCP (Painel → Conexões → Seus sistemas): endereço + token (só no computador), `tools/list` vira ferramentas `<prefixo>__<ação>` na sessão (`tools.todas()`), ação com `destructiveHint` pede `confirmado`, cada ação liga/desliga. Conexão com prazo de 8 s (fora do ar, a conversa começa sem ele). O WorkFlow Cunae (repo do Luca) tem o servidor MCP em `/api/mcp` e tokens em Configurações → Conta.
- Vários monitores: `hands.py` mapeia a câmera para a área de trabalho inteira (`pc.desktop_bounds`) e manda `gx/gy` globais; cada camada (`Overlay.tsx`) pega a mão que está no monitor dela (e segura até soltar, para arrastar entre telas); cliques e janelas vão com o ponto global.
- `overlay.py`: o que a camada mostra quando ele olha/age (`olhar`) e o "parar".
- `tools.py`: ferramentas do modelo. `pesquisar_web` é `NON_BLOCKING`. Todas rodam em task à parte.
- `memory.py`: memória em mapa (estilo Obsidian). Tabelas `memorias`, `temas`, `ligacoes` (rótulos `sobre` memória→tema, `parte de` tema→tema/`eu`, `relacionado` memória↔memória por cosseno ≥ 0,74). `search` parte das mais parecidas e segue as ligações; `reflect` extrai memórias já com temas; `organize` liga as soltas; `write_vault` escreve `Memória/` (uma nota por tema com [[ligações]], só reescreve notas com a marca do Jarvis). Página `/memoria` (d3-force), ferramenta `mostrar_memoria`.
- Financeiro (`finance.py` + `finance_voz.py`, motor em `financeiro/motor/`): as regras da Carteira Pessoal (Node + better-sqlite3, ~150 operações em `db/router.js`, leitores de extrato de Inter/Nubank/Santander/Mercado Pago, faturas, metas, relatórios; `npm test` = 76 verificações). O núcleo sobe o motor (`servidor.js`, 127.0.0.1 + token, morre junto pela entrada padrão) com o Node empacotado (`_internal/node`), dados em `<pasta do Jarvis>/financeiro/`. Telas da Carteira em `frontend/public/financeiro/` (`ponte.js` troca o IPC do Electron por `/api/fin/c/<operação>`; diálogos de arquivo do sistema pelo núcleo; `tema-jarvis.css`). Voz: `financeiro_*` (lançar salva na hora com cartão e Desfazer; `financeiro_fixa` para despesa/receita que repete todo mês). Avisos: vencimentos, orçamento ≥ 80%, fechamento no último dia (`alerts.py`); finanças no bom dia (`briefing._financas`). Plano em `docs/plano-financeiro.md`.
- Dados: `briefing.py` + `sources/`, `alerts.py`, `activity.py` (memória de trabalho, sugestões, modo foco), `agents.py` (tarefas para Claude Code/Codex/ChatGPT), `protocols.py`, `market.py`, `system.py`, `store.py`.
- `app.py`: API, `/ws` (só JSON; ao conectar manda `sync` e o estado da câmera), páginas. `/api/app/comandos`: o app espera ali pedidos de janela (mostrar, minimizar, esconder, memoria) vindos do ouvido e das ferramentas, então funciona com tudo escondido. `/api/camera/ao-vivo`: vídeo MJPEG. `JARVIS_TESTE=1` sobe sem microfone, câmera e ouvido (testes e CI).

### Interface (`frontend/src/`)
- `lib/live.ts`: stores fora do React para `vivo` e `maos` (nada re-renderiza 30 vezes por segundo). `lib/socket.ts` joga esses eventos direto nos stores.
- `ui/Aura.tsx`: esfera Aura (shader da LiveKit, MIT) num renderizador WebGL próprio; reage à fase e ao volume.
- `hud/`: HUD (colunas de painéis, esfera, legenda, botão Parar, painéis/widgets em `Deck`/`Widgets`).
- `memoria/`: mapa da memória (`/memoria`), janela própria aberta pelo app.
- `ui/CameraView.tsx`: vídeo da câmera com o esqueleto das mãos (painel "Visão · Câmera" e quadradinho do canto).
- `overlay/`: camada por monitor. Cartões com `zoom` (nítidos), sem desfoque. Cada cartão fica ~10 s e vai para a caixa no canto (fixado, ou com mão/mouse em cima, fica). Controles rápidos ao passar o mouse na esfera do canto (falar, câmera, tela, memória, HUD); aviso do gesto reconhecido. Cartões na área de trabalho (arrastar, alça de tamanho, fechar, fixar), esfera mini + quadradinho do mapeamento da mão quando o HUD está minimizado, esfera que voa em curva até onde ele olha, borda azul na janela mirada, cursor da mão. `handControl.ts`: **um modo só** (pinça e solta clica; pinça e mexe arrasta cartão ou janela; pinça parada → anel → ajuste em L; dois dedos rolam; borda joga para outro monitor). Elementos com `data-hit` recebem o mouse (a casca consulta `regioes`).
- `setup/`: configuração inicial em 4 passos (boas-vindas, chave com teste, nome/cidade/voz/câmera, permissões).

## Compilar e entregar

Tudo pela compilação automática (`.github/workflows/build.yml`): tag `v*` ou "Run workflow". Para cada sistema: modelos (`scripts/modelos.sh`, inclui o português do OCR), interface, motor financeiro (`npm ci` + `npm test` + cópia do Node), núcleo (PyInstaller + `--verificar`), teste do núcleo (inclui o financeiro), Tauri. A etapa final junta `Jarvis-<versão>.zip` (Mac/, Windows/, Linux/, `LEIA-ME.txt`).
- **O GitHub é só a máquina que compila** (pedido do Luca, 26/10/2026): nada é publicado (sem Releases), o zip fica guardado 1 dia e `scripts/baixar-zip.sh` baixa para a Mesa e apaga de lá. Os dados de quem usa (memória, financeiro, chave) nunca saem do computador da pessoa.
- Mac: app assinado com o certificado próprio "Jarvis Local" (segredos `MAC_CERT_P12`/`MAC_CERT_PASS`), para as permissões não caírem a cada versão, e entregue como instalador `Instalar Jarvis.pkg` (`scripts/pacote-mac.sh` + `packaging/mac/`: boas-vindas, fecha a versão aberta, instala em /Applications sem realocar, abre ao terminar). O .pkg não é assinado (sem conta da Apple): primeira vez por Ajustes → Privacidade e Segurança → "Abrir Mesmo Assim". App instalado pelo .pkg não fica em quarentena.
- Windows: instalador NSIS `Instalar Jarvis.exe` (aviso do SmartScreen: "Executar assim mesmo").
- Linux: AppImage e .deb (depende de libportaudio2, wmctrl, xdotool, xclip).
- Versão em `VERSION` (e em `app/src-tauri/tauri.conf.json` e `Cargo.toml`).

Local, para desenvolver: `scripts/modelos.sh`; `npm --prefix frontend run build`; `JARVIS_TESTE=1 uv run --directory backend python -m jarvis.app` (porta 8765); `cd app && npx tauri build --bundles app` (exige `backend/dist/jarvis-core`: `uv run --group build pyinstaller jarvis-core.spec`). No terminal do VS Code, apps Electron/Tauri podem herdar `ELECTRON_RUN_AS_NODE`.

## Segurança das ações

Ações destrutivas (`arquivos` → organizar, lixeira; atalhos como cmd+q/alt+f4) exigem `confirmado=true` depois do sim. Arquivos só na pasta pessoal; lixeira recuperável (send2trash). Sem execução de comando livre: o controle é por teclado e mouse à vista; o Jarvis não digita senhas nem dados de cartão. Tarefas para outras IAs ficam em `~/Jarvis/Tarefas`, cada uma com repo git próprio.

## Limites do plano gratuito da Gemini

Busca embutida do Google tem cota zero no gratuito: a pesquisa é `pesquisar_web` (DuckDuckGo + Google Notícias RSS). Texto e embeddings são grátis, com cota diária (o `gemini-3.8-flash` às vezes dá 503/429; a memória cai para o lite).

## Visual

Azul-noite, acento ciano, Space Grotesk / Manrope / JetBrains Mono, painéis com borda ciano e brilho (referência em `docs/referencia-lucas-victor.md`). Painel no estilo da skill `estilo-workflow`.

## Convenções

- Textos de interface em português do Brasil, sentence case.
- Nunca inventar dados nos cartões; demonstração usa dados marcados como exemplo.
- Histórico do plano: `docs/plano-v2.md` (esta reconstrução) e `docs/plano-fase-11.md` (ideias de antes).
