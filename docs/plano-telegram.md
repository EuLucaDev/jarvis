# Plano: Jarvis no Telegram (e o Jarvis da noiva)

30/10/2026, a partir das respostas do Luca.

## O que ele quer

- Um robô no Telegram que é o **mesmo Jarvis** do notebook: mesma memória, mesmo financeiro, mesmo WorkFlow.
- Funciona sempre, até com o notebook desligado.
- Pelo Telegram: texto, áudio, foto de nota fiscal ou comprovante de Pix, extrato (PDF, CSV, OFX); responde
  formatado, com botões, e manda relatório em imagem e em PDF bem diagramados.
- Poderes: financeiro, WorkFlow, perguntas, pesquisa, memória e lembretes. **Nada de mexer no computador**
  pelo Telegram.
- A noiva usa o mesmo robô, na conversa dela (outro número), com o financeiro e a memória **só dela**. Depois
  ela instala o Jarvis dela, que já encontra tudo isso pronto.

## A mudança de arquitetura

Hoje tudo mora no notebook. Para estar sempre ligado e ser o mesmo nos dois lugares, nasce o **Jarvis na nuvem**:
um núcleo do Jarvis sem microfone, câmera nem tela, rodando na VPS dele (Coolify), que passa a ser a casa do
financeiro e da memória.

```
 Telegram ──► Jarvis na nuvem (VPS) ◄──── Jarvis do notebook (voz, mãos, tela)
              · robô do Telegram           · o financeiro e a memória vêm da nuvem
              · cérebro de texto (Gemini)  · sem internet: guarda e sincroniza depois
              · financeiro e memória
              · um perfil por pessoa  ◄──── Jarvis da noiva (depois)
```

- O notebook continua fazendo o que só ele faz: voz ao vivo, mãos, tela, controle do computador.
- **Feito em 30/10/2026** (fases 1 a 6), testado com um Telegram falso e a Gemini de verdade. Sem internet, o
  financeiro do notebook avisa que está fora do ar (não há fila local: a nuvem é a casa do financeiro).
- Financeiro e memória passam a ser da nuvem. O notebook lê e grava lá, pela mesma rota que as telas da Carteira
  já usam (`/api/fin/c/...`), só que encaminhada para a nuvem.
- **Perfis:** cada pessoa tem sua pasta, seu banco do financeiro, sua memória e sua chave de acesso. O Telegram
  identifica quem fala pelo número da conta; quem não estiver na lista não recebe resposta.
- **Segurança:** a nuvem só aceita o notebook e o Telegram, por HTTPS com token por pessoa. Backup diário,
  criptografado, no R2 dele. Ações que apagam ou pagam pedem botão "Confirmar". Os dados ficam no servidor dele,
  não com terceiros (mas passam pelo Telegram e pela Gemini, como já passam pela Gemini hoje).
- **Primeira vez:** o financeiro e a memória que já estão no notebook sobem para a nuvem uma vez (com backup antes).
  Na versão nova, o notebook pergunta se pode subir.

## O robô

| Ele manda | O Jarvis faz |
|---|---|
| Texto | Responde como o Jarvis (mesmo jeito de falar), com as mesmas ferramentas por assunto. |
| Áudio | A Gemini ouve o áudio direto (sem transcrição separada) e entende: "gastei 80 no mercado no crédito do Nubank em 2x". |
| Foto de nota fiscal ou comprovante de Pix | Lê valor, data, estabelecimento e forma de pagamento, sugere a categoria e mostra o lançamento com botões **Lançar**, **Editar** e **Descartar**. |
| Extrato (PDF, CSV, OFX ou foto) | Usa os leitores de extrato do financeiro (Inter, Nubank, Santander, Mercado Pago), mostra o resumo do que vai importar e pede **Importar**. |
| "Relatório do mês" | Manda um cartão em imagem (gráfico, totais, categorias) e, se ele quiser, o PDF completo. |

- **Respostas:** texto com negrito e listas, valores alinhados, e botões (Desfazer, Confirmar, Ver detalhes,
  Próximo mês).
- **Relatórios:** um modelo só em HTML no visual do Jarvis (azul-noite, ciano, Space Grotesk e Manrope), que vira
  imagem (o cartão na conversa) e PDF (várias páginas: fechamento do mês, categorias, comparação, metas, faturas).
  O desenho é feito num navegador sem tela, no servidor.
- **Lembretes e iniciativa:** o que hoje o Jarvis avisa no notebook (contas vencendo, orçamento passando de 80%,
  fechamento do mês, cliente que respondeu no WorkFlow) também chega no Telegram. Se o notebook estiver em uso, o
  aviso vai para ele; se não, vai para o Telegram.
- **Comandos:** `/hoje` (resumo do dia), `/mes` (relatório), `/contas` (o que vence), `/desfazer` e `/ajuda`.

## A noiva

1. Ele manda um convite pelo painel (Painel → Telegram → Convidar), que gera um código.
2. Ela abre o robô, manda o código e vira um perfil novo: financeiro vazio, memória vazia, configuração inicial
   pela própria conversa (nome, como quer ser chamada, contas e cartões).
3. As conversas são separadas: o robô nunca mistura os dados dos dois. Ele não vê o financeiro dela, nem ela o dele.
4. Quando ela instalar o Jarvis no computador dela, entra com o perfil dela e o financeiro dela aparece lá.

## Fases

| Fase | Entrega | Tamanho |
|---|---|---|
| 1 | Jarvis na nuvem: núcleo sem microfone e câmera na VPS, perfis, financeiro e memória lá, backup no R2 | médio |
| 2 | Notebook ligado na nuvem: financeiro e memória pela nuvem, subida dos dados atuais, modo sem internet | médio |
| 3 | Robô: texto e áudio, mesmas ferramentas, botões de confirmar e desfazer, lista de quem pode falar | médio |
| 4 | Fotos e extratos: nota fiscal, Pix e extrato viram lançamentos com confirmação | médio |
| 5 | Relatórios em imagem e PDF no visual do Jarvis; `/mes`, `/hoje`, `/contas` | médio |
| 6 | Perfis com convite (a noiva), avisos indo para o Telegram | pequeno |

As fases 1 a 3 já deixam ele usando o Jarvis pelo Telegram. A 4 e a 5 são o "lançar sem abrir o notebook" e o
relatório bonito.

## O que ele faz antes de começar

1. No Telegram, abrir o **@BotFather**, mandar `/newbot`, escolher o nome (ex.: Jarvis) e o usuário (tem que
   terminar em `bot`, ex.: `jarvis_luca_bot`). O BotFather devolve um **token**: ele cola esse token no painel do
   Jarvis quando a fase 3 estiver pronta (o token nunca vai para o GitHub).
2. Nada mais: o servidor, o domínio e o backup eu configuro (cada publicação na VPS ainda passa pela aprovação dele).

## Custos e limites

- Telegram: grátis. Arquivos de até 20 MB (extrato e foto cabem com folga).
- Gemini: a mesma chave, agora usada também pela nuvem. Texto, áudio e imagem cabem no plano grátis para uso
  pessoal; com faturamento ativo ele ganha a Pro e a busca do Google.
- VPS: já existe. O Jarvis na nuvem usa pouca memória (sem voz ao vivo nem câmera).
