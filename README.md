# J.A.R.V.I.S. 2

Assistente de voz para Mac, Windows e Linux: diga "Jarvis" (ou bata duas palmas), converse por voz, veja as respostas em cartões flutuando na tela e use a mão pela câmera como ponteiro, inclusive para arrastar e redimensionar as janelas de qualquer app.

## Instalar

Baixe o `Jarvis-<versão>.zip` em **Releases**, extraia e siga o `LEIA-ME.txt` da pasta do seu sistema. Na primeira vez abre a configuração inicial (chave grátis da Gemini, nome, cidade, voz e permissões).

## Como funciona

- **App** (`app/`, Tauri): ícone na barra de menus/bandeja, HUD, camada transparente sobre a tela, Alt+Espaço, abre com o computador.
- **Núcleo** (`backend/`, Python): voz (Gemini Live), ouvido offline ("Jarvis" e palmas), mãos (MediaPipe), controle do computador e dados (memória, briefing, e-mail, agenda, notícias, mercado).
- **Interface** (`frontend/`, React): HUD com a esfera Aura, cartões, configuração inicial e painel.

## Compilar

A compilação dos três sistemas roda no GitHub Actions (`.github/workflows/build.yml`) ao enviar uma tag `v*`; o zip final sai como versão. Detalhes para desenvolver estão no `CLAUDE.md`.

## Créditos

A esfera "Aura" vem dos componentes de agente da LiveKit (licença MIT, © 2025 LiveKit, Inc.).
