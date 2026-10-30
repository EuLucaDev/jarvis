# Plano 2.8: mãos firmes, Jarvis completo e imersão

30/10/2026, a partir das respostas do Luca.

## 1. Mãos

### Por que hoje está "embaralhado"
- Cada mão é seguida pelo rótulo esquerda/direita do MediaPipe, que troca de um quadro para o outro. A cada troca a mão "some e volta": perde a pinça em andamento, o filtro, e fica 0,25 s sem poder clicar.
- Mão com rótulo abaixo de 70% de certeza é jogada fora.
- "Palma virada para você" depende desse mesmo rótulo, e o sinal ficou invertido (o menu abria com a palma para a câmera).
- Câmera em 640x480, só o miolo vira a tela: pouco pixel por dedo.

### Motor novo
| Motor | Onde | Prós | Contras |
|---|---|---|---|
| **Apple Vision** (hand pose, nativo do macOS) | Mac | Roda no Neural Engine, não precisa baixar modelo, diz qual mão é e a confiança de cada ponto; feito para a câmera do MacBook | Só Mac |
| **RTMPose (rtmlib)** | Mac, Windows, Linux | Mais preciso que o MediaPipe nos testes acadêmicos de mão; só precisa de onnxruntime | Modelo de ~50 MB a mais no instalador; mais pesado na CPU |
| WiLoR / HaMeR (mão 3D) | — | O melhor com a mão virada e dedos escondidos | Precisa de placa de vídeo; não serve para notebook |
| MediaPipe (atual) | todos | Leve | É o que está frágil |

Proposta: **Apple Vision no Mac** (o computador do Luca) e **RTMPose ou o MediaPipe consertado** no Windows/Linux, atrás de uma mesma interface (`hands_motor`). O painel ganha "Motor das mãos" para trocar e comparar.

### O que muda em qualquer motor
- Seguir a mão pela posição (a mais próxima do quadro anterior), com o lado da mão decidido por votação ao longo de vários quadros.
- Nunca descartar a mão por rótulo duvidoso; só por tamanho/confiança dos pontos.
- Câmera em 1280x720.
- **Calibração na primeira vez** (configuração inicial + "Recalibrar" no painel): faça a pinça, abra, vire a palma para você, feche a mão, aponte para os quatro cantos. Guarda os limites da sua mão e a área da câmera que vira a tela.

### Gestos (os que o Luca quer)
- Ponteiro, pinça = clique, pinça e arrasta = rolar (Meta).
- Menu da palma (palma para você + pinça), com o lado corrigido.
- Janelas do jeito antigo: pinça na janela e arrasta = move; **pinça parada → anel → abrir/fechar polegar e indicador = tamanho**, parado fixa; borda = outro monitor.
- Microgestos e pinça do médio ficam, mas desligados de início.

## 2. Zerar
Ferramenta `zerar` com níveis: memória do Jarvis, histórico e cartões, financeiro, tudo (como instalação nova). Ele diz o que vai apagar, espera o "sim" e faz **backup antes** (fica 30 dias, com "desfazer o zerar").

## 3. Financeiro e WorkFlow 100% por ações prontas
Uma ação de voz por grupo de assunto cobrindo todas as 137 operações do financeiro e todas as rotas úteis do WorkFlow, carregadas por assunto (para a voz não se perder). O modo avançado fica só de reserva.

## 4. Imersão
- **Jarvis bem presente:** fala sozinho sobre reunião, contas, cliente que respondeu, tarefa atrasada, e também sobre o que você está fazendo (tempo no mesmo arquivo, pausas, sugestões).
- **Tela sem espelho:** desligada por padrão; quando você fala com ele, ou diz "veja minha tela", ele captura a tela (ou todas) naquela hora, sem aparecer no HUD.
- **Voz de filme:** filtro leve de rádio/HUD na voz, jeito de falar mais formal e espirituoso ("senhor"), sons de interface.
- **HUD que sente o ambiente:** percebe quando você chega ou sai da frente da câmera, cumprimenta, apaga quando você sai.

## Ordem sugerida
1. Mãos (motor + rastreamento + calibração + gestos antigos de janela).
2. Zerar.
3. Imersão (presença, tela sob demanda, voz e sons).
4. Cobertura total do financeiro e do WorkFlow.
