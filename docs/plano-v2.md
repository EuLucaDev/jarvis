# Jarvis 2: plano de reconstrução

Escrito em 25/10/2026, depois de testar o app Electron no Mac do Luca. Este plano substitui as ondas do `plano-fase-11.md` no que diz respeito ao app, aos gestos e ao controle do computador.

## O que deu errado (diagnóstico)

1. **As permissões do macOS nunca vão funcionar direito na arquitetura atual.** Quem mexe no Mac (mouse, teclado, janelas, tela) é um processo **Python** que o app abre. Esse Python vem do instalador do python.org, que é um app próprio ("Python.app"), e o macOS confere a permissão *dele*, não a do "Jarvis". Por isso você ligou o Jarvis em Acessibilidade e o servidor continuou dizendo "sem permissão". Além disso, o app tem assinatura local (ad hoc), que muda a cada reinstalação e apaga a permissão.
2. **A interface trava porque faz trabalho pesado no lugar errado.** O reconhecimento da mão (MediaPipe) roda dentro da página do HUD, junto com a esfera em canvas, os espectros e o React re-renderizando. Tudo disputa o mesmo processo do navegador.
3. **Camadas demais para a mesma coisa.** Hoje existem três jeitos de desenhar um cursor do Jarvis (HUD, camada do Electron e um app AppKit à parte), dois "ouvidos" (Chrome e macOS), e modos que brigam entre si: cartões, mouse, janelas e quadro. Cada camada nova consertou a anterior e acrescentou bugs.

## Atualização (25/10/2026): Mac **e** Windows

O Luca quer o Jarvis nos dois sistemas, entregue como **zip**, com uma **configuração inicial** na primeira vez que abre (chave da IA, nome, cidade, permissões). Swift fica só no Mac, então a casca passa a ser **Tauri 2 (Rust)**. A tabela abaixo (Swift) vale como referência do que cada parte precisa fazer; a pilha nova é esta:

| Parte | Jarvis 2 multiplataforma |
|---|---|
| Casca, bandeja, atalho global, abrir no login, janelas flutuantes | **Tauri 2 (Rust)**: ~10 MB no Mac, ~6 MB no Windows; usa o navegador do próprio sistema (WebKit no Mac, WebView2 no Windows) |
| HUD, cartões, painel | **React** (o que já existe, limpo); cartões viram janelas do Tauri, transparentes e sem moldura |
| Mãos | **Rust + ONNX Runtime** com os modelos de mão do MediaPipe, numa linha de execução própria, fora da interface. Igual nos dois sistemas. |
| Controle do PC | **Rust**, uma parte por sistema. No Mac: Acessibilidade, `CGEvent`, ScreenCaptureKit. No Windows: UI Automation, `SetWindowPos`, `SendInput`, captura de tela. Por cima, uma interface única (`pegar janela`, `mover`, `clicar`, `digitar`, `ver área`). |
| Voz (Gemini Live) | Na janela do HUD, como hoje (o navegador já faz o cancelamento de eco) |
| "Jarvis" e palmas | **Rust**: microfone pelo `cpal`, palmas por energia e a palavra pelo **Vosk** (reconhecimento offline em pt-BR, modelo pequeno de ~50 MB), igual nos dois sistemas |
| Dados (memória, briefing, e-mail, agenda, notícias, mercado, tarefas para outras IAs) | **Python**, empacotado como executável (PyInstaller) dentro do app, um para cada sistema |
| Entrega | `Jarvis-mac.zip` (o app) e `Jarvis-windows.zip` (pasta com o `Jarvis.exe`). Na primeira abertura, um assistente pede a chave da Gemini, o nome e a cidade e passa pelas permissões. |

**O que acontece sem assinatura paga:**
- **Mac:** na primeira vez, é preciso clicar com o botão direito no app e escolher "Abrir". As permissões ficam fixas com o certificado local.
- **Windows:** o SmartScreen avisa "aplicativo não reconhecido". É só clicar em "Mais informações → Executar assim mesmo".
- Para tirar esses avisos de vez, é preciso a conta da Apple (US$ 99 por ano) e um certificado de assinatura para o Windows.

**Novo pedido no visual:** com os gestos ligados e o HUD minimizado, ao lado da esfera do canto fica um **quadradinho com o mapeamento da mão** (o esqueleto, ao vivo), para ver se a câmera está pegando.

**Antes de começar:** o Luca vai mandar o repositório de outra pessoa. A pilha final e o que dá para reaproveitar dele entram aqui depois dessa análise.

## Referência: a versão só para Mac (Swift)

| Parte | Hoje | Jarvis 2 |
|---|---|---|
| App, janelas, HUD | Electron (Chrome embutido, 257 MB) | **Swift + SwiftUI**, nativo do macOS (~15 MB) |
| Voz (microfone, alto-falante, Gemini Live) | Página web + Python | **Swift**: `AVAudioEngine` com cancelamento de eco nativo (dá para interromper sem fone) e WebSocket direto com a Gemini Live |
| Mãos | MediaPipe no navegador | **Vision da Apple** (`VNDetectHumanHandPoseRequest`), no chip de IA do Mac, a 30 quadros por segundo, sem pesar a interface |
| "Jarvis" e palmas | Chrome ou Python + Speech | **Swift + Speech**, no aparelho, em português |
| Controle do Mac (janelas, mouse, teclado, tela) | Python + pyobjc | **Swift** (Acessibilidade, `CGEvent`, ScreenCaptureKit) |
| Cartões | Dentro do HUD | **Janelas flutuantes de verdade** na área de trabalho: você move, aumenta e fixa como qualquer janela, com a mão ou o mouse |
| Dados (memória, briefing, e-mail, agenda, notícias, mercado, tarefas para outras IAs, protocolos) | Python (FastAPI) | **Continua em Python**, sem mudança grande. Vira um serviço "cérebro" que o app consulta, sem tocar no Mac. |
| Painel de ajustes (`/admin`) | React | **Continua em React**, aberto numa janela do app |

**Por que Swift e não outra linguagem:**
- Tudo o que precisa de permissão ou de velocidade (voz, câmera, mãos, janelas, tela) é API nativa da Apple, e um único processo assinado como "Jarvis" recebe todas as permissões. Isso resolve o problema 1 de vez.
- A Vision faz a leitura da mão no chip de IA, sem tirar quadros do HUD, o que resolve o problema 2.
- Já existe Swift 6.2 instalado aqui; dá para compilar sem abrir o Xcode.

**O que não vale trocar:**
- **Python** continua ótimo para a parte de dados, que não é tempo real e já funciona.
- **Rust/Tauri** obrigaria a mesma conversa com o macOS por camadas extras.
- **Electron** é o que temos hoje.

**A troca:** Swift é só macOS. Se um dia o Windows for prioridade, a parte de dados (Python) e o painel (React) aproveitam, mas a casca e o controle do PC têm que ser refeitos para Windows. O plano é Mac primeiro.

## Como fica a experiência (sem "modos")

- **Liga com o Mac**, escondido: só o ícone na barra de menus. "Jarvis" ou duas palmas fazem o HUD aparecer com a abertura, e ele fala (de manhã, com o bom dia).
- **Câmera ligada sozinha** quando o app abre (indicador verde do macOS aceso). "Jarvis, desliga a câmera" e "liga a câmera" por voz, ou pelo ícone.
- **A mão é sempre um ponteiro na tela inteira.** Não existe modo mouse, modo janela ou modo cartão. O gesto vale para o que estiver embaixo:
  - **pinça e solta:** clica (qualquer app);
  - **pinça e mexe:** arrasta (qualquer janela, inclusive cartões e o HUD); arrastar até a borda e segurar manda para o outro monitor;
  - **pinça parada:** um anel enche e entra no ajuste de tamanho; polegar e indicador em L aumentam ou diminuem; parado de novo fixa; mão aberta cancela;
  - **dois dedos para cima ou para baixo:** rola;
  - **mão aberta para cima:** mostra o HUD; **para baixo:** minimiza.
- **Cartões viram janelas na área de trabalho.** "Como está o mercado?" faz o cartão aparecer flutuando, com borda ciano. Ele dá para mover, aumentar e fixar como qualquer janela, e some sozinho se você não mexer.
- **"Jarvis, faça tal coisa":** ele controla o Mac à vista. A esfera vai até o lugar, ele clica e digita, e mostra o plano quando a tarefa tem vários passos. "Jarvis, minimize sua tela", "Jarvis, abre o Notas e escreve…", "olha essa planilha e corrige a coluna B".

## Etapas

Cada etapa termina com algo que você usa de verdade e com um teste que diz se ficou pronto.

### Etapa 0 · Preparar (meia sessão)
- **Certificado de assinatura local fixo** ("Jarvis Local"). O macOS pede a sua senha uma vez. A partir daí as permissões não caem mais a cada atualização.
- **Commit** de tudo o que existe hoje, como ponto de retorno.
- **Pronto quando:** o app de teste assinado com o certificado mantém a Acessibilidade depois de ser recompilado.

### Etapa 1 · Esqueleto nativo (1 sessão)
- `JarvisApp` em Swift (SwiftPM):
  - ícone na barra de menus, abre escondido no login;
  - HUD em SwiftUI com a esfera (Metal) e as legendas;
  - janela do painel `/admin` (web, como hoje).
- Sobe o serviço Python como um ajudante sem permissões especiais.
- **Pronto quando:** o app liga com o Mac, o ícone aparece, ⌥ Espaço mostra o HUD e a esfera roda lisa.

### Etapa 2 · Voz nativa (1 a 2 sessões)
- Microfone e alto-falante no Swift, com cancelamento de eco.
- Gemini Live por WebSocket.
- As ferramentas de dados chamam o serviço Python; as do Mac ficam no Swift.
- "Jarvis" e palmas em segundo plano; abertura e bom dia.
- **Pronto quando:** você chama com o app escondido, ele aparece e conversa, e dá para interromper falando, sem fone.

### Etapa 3 · Mãos nativas (1 a 2 sessões)
- Vision lendo a mão a 30 fps.
- Ponteiro por cima de tudo; clicar, arrastar, ajustar, rolar e jogar para o outro monitor, em qualquer janela.
- Câmera ligada sozinha, e por voz.
- **Pronto quando:** você pega o Brave, joga para o outro monitor, aumenta e fixa, sem tocar no mouse, e sem a interface travar.

### Etapa 4 · Cartões na área de trabalho (1 sessão)
- Cada cartão (pesquisa, clima, mercado, plano, tarefas…) vira uma janela flutuante nativa.
- O mesmo gesto das janelas move, ajusta e fixa os cartões; no mercado, o ajuste troca o período.
- **Pronto quando:** "como está o mercado?" põe o cartão na área de trabalho e você o arruma com a mão.

### Etapa 5 · Trabalhar junto (1 sessão)
- Leva para o Swift: `olhar` (com a esfera voando até lá), `clicar` pelo nome, `digitar`, `teclas`, `contexto_atual`, trocar a seleção, plano visível, Esc para parar.
- **Pronto quando:** "tá vendo essa barra lateral? fecha a terceira aba" funciona à vista, do começo ao fim.

### Etapa 6 · Limpeza e entrega (meia sessão)
- **Apagar o que fica velho:**
  - o app Electron (`desktop-app/`);
  - o modo mouse;
  - `overlay_app.py`, `listener_app.py`, `desktop.py`, `windows.py` e `context.py` (que viram Swift);
  - os gestos e a palavra de ativação no navegador (`lib/gestures.ts`, `hud/air.ts`, `lib/wake.ts`);
  - o lançador de telas no Chrome e os serviços antigos do launchd.
- **Ficam:** o painel, as telas extras e o serviço Python de dados.
- Atualização automática para a versão nova, com a animação.
- **Pronto quando:** sobra um app só, o código antigo some e a documentação descreve só o que existe.

## O que eu preciso de você

1. **Pode ser Swift (só Mac)?** Ou o Windows precisa estar no horizonte próximo?
2. **Autoriza criar o certificado local?** O macOS vai pedir a sua senha uma vez.
3. **Repositório privado no GitHub** (`EuLucaDev/jarvis`) para as atualizações automáticas: posso criar?
