# Referência: Jarvis do Lucas Victor (jarvis.lucasvictor.ai), estudado em 21/10/2026

Site de apresentação do sistema que aparece nos vídeos. Serve de referência de layout e de funções; o código dele não é público.

## Linguagem visual

- Fundo azul-noite `oklch(0.12 0.03 255)` com grade fina e brilho azul atrás do conteúdo.
- Acento ciano `oklch(0.8 0.13 205)`; estado "em espera" em azul `oklch(0.65 0.19 255)`.
- Painéis: borda 1px ciano a 25%, raio 12px, fundo quase transparente, brilho externo azul.
- Tipografia: Space Grotesk (títulos, peso 500, tracking −0.025em), Manrope (texto), JetBrains Mono (rótulos em caixa alta, tracking largo, 9–11px).
- Rótulos de painel no formato `ÁREA · ASSUNTO` com ícone à esquerda e pílula de status à direita.

## Monitor principal (1280×760)

- Barra superior: `JARVIS · ASSISTENTE DE IA` | pílula central `PERSONALIZADO · SINCRONIZADO | GERENCIAR HUD` | `● SISTEMA ONLINE · VOICE LINK ARMANDO · 13:00`.
- Coluna esquerda: `SINAL · ENTRADA` (onda ao vivo), `SINAL · ESPECTRO` (barras, 20Hz–20kHz), `VOZ · LEITURA` (%), `NÚCLEO · SERVIÇOS` (Núcleo, Reconhec. de voz, Motor NLP, Microfone, Síntese de voz com status).
- Centro: `EM ESPERA` com régua de traços embaixo e a esfera.
- Coluna direita: `SENSORES · CLIMA` (anel de umidade + temperatura), `JARVIS · CANAL ATIVO` (log da conversa + campo "Escreva para o JARVIS…").
- Barra inferior: botão `TELAS` | microfone central | ícones (câmera, gestos, volume, mic) | `NUVEM · <modelo>`.

## Telas extras (540×960, em pé)

- Topo: `JARVIS · <TELA>`, `● SINCRONIZADO`, relógio, botões. Abaixo, abas de visões: Centro de comando, Agenda tática, Comunicações, Radar de notícias, Núcleo do sistema.
- Agenda · próximos 7 dias: "Seu período organizado", bloco `PRÓXIMO` com hora grande + local, lista lateral.
- Comunicações · e-mail: "Pedem sua atenção", contador grande "4 mensagens exigem ação", lista numerada "Precisam de ação", seção "Outros relevantes", rodapé "Triagem do briefing · itens verificados".
- Radar · notícias: um painel por tema, `DESTAQUE` com imagem, itens numerados 02/03 com fonte, rodapé "Curadoria atual · fontes verificadas".
- Rodapé: nome da tela | botão `ATUALIZAR DADOS` | `MONITOR ACTIVE`.

## Briefing

Sequência: Presença detectada → Reconhecimento facial → Sistema desbloqueado → Briefing iniciado → Panorama do dia, com moldura de rosto "Aguardando/Reconhecido".

## Funções listadas no site

Memória visível e apagável; palavra de ativação; personalidade; bom dia narrado (agenda, e-mails, notícias, clima, saúde); ações no computador, casa e impressora 3D; confirmação antes de enviar/apagar/mudar; conexões (Apple Saúde, WHOOP, Strava, Oura, Google Calendar, Notion, Obsidian, Drive, Gmail, Outlook, Slack, WhatsApp, iMessage, cotações, RSS, Spotify, impressora 3D, clima); dashboards (saúde, finanças) sem dados inventados; escolha de modelo; dados locais.

## Repositório de aulas (eletronicaoquadrado-tech/jvs_auth_92kx)

LiveKit + Gemini realtime + Mem0 + automação Windows + Voice Monkey (Alexa). Sem licença na raiz: usar só como referência. Contém chaves reais versionadas; não usar.
