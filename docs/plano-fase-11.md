# Plano: próximas fases do Jarvis

Montado em 23/10/2026, depois da fase 10 (uma tela primeiro, sons, tarefas para outras IAs). Tudo o que está aqui roda sem custo extra, exceto onde está marcado.

Cada etapa traz um tamanho aproximado (**P** = uma sessão curta, **M** = uma sessão, **G** = mais de uma) e o teste que diz se ficou pronto.

## Ordem sugerida

| Onda | Foco | Etapas | Por quê nesta ordem |
|---|---|---|---|
| A | Base | A1 backup, A2 testes automáticos | Protege o que já existe antes de mexer em mais coisa. |
| B | Uso diário | B1 agenda por voz, B2 resumo do fim do dia, B3 responder e-mail, B4 modo reunião | É o que você usa todo dia. |
| C | Fora do Mac | C1 acesso seguro (túnel + login), C2 celular como controle, C3 presença automática | O celular depende do túnel por causa do HTTPS. |
| D | Experiência | D1 interromper sem fone, D2 animação de boot, D3 cartões manipuláveis, D4 voz própria | Fica por último porque é acabamento sobre uma base estável. |
| E | Maestro | E1 progresso ao vivo, E2 fila de projetos, E3 criar imagem e post | Cresce em cima das tarefas da fase 10. |
| F | Medição | F1 painel de latência e cotas | Mostra onde ainda está lento. |

---

## Onda A · Base

### A1 · Backup diário · P
- Cópia diária de `data/jarvis.db` (memória, conversas e ajustes) para `~/Jarvis/Backups`, guardando as últimas 14.
- Opcional: subir a cópia mais recente para o Google Drive pela pasta sincronizada do Drive para Mac, se estiver instalado. Sem API e sem login novo.
- Restaurar um backup pelo painel Sistema.
- **Pronto quando:** apagar uma memória, restaurar o backup de ontem e ela voltar.

### A2 · Testes automáticos · M
- Script `scripts/testar.sh` que sobe o servidor e roda um cliente WebSocket, como os testes feitos à mão na fase 10: painel, protocolo, pesquisa sem bloqueio, pergunta ao ChatGPT e cartões.
- Testes rápidos sem rede para `protocols.find`, `agents._cmd`, o roteiro do briefing e o plano dos monitores.
- Checagem visual do HUD em 1920, 1440 e 1280 com prints, para pegar quebra de layout.
- **Pronto quando:** `scripts/testar.sh` passa inteiro em menos de 2 minutos.
- **Custo:** os testes de voz usam a cota grátis da Gemini (poucas chamadas).

---

## Onda B · Uso diário

### B1 · Agenda por voz · M
- Ferramenta `criar_evento` (título, início, fim, local, convidados opcionais) que grava no app Calendário do Mac via AppleScript, no calendário escolhido no painel.
- Se esse calendário for a conta Google ligada ao Mac, o evento aparece no Google Agenda e no celular.
- Também `mover_evento` e `cancelar_evento`, ambos com confirmação falada.
- Cartão de confirmação com data e hora antes de gravar.
- **Pronto quando:** "Jarvis, marca dentista sexta às 14h" cria o evento e ele aparece no iPhone.
- **Atenção:** o macOS pede permissão de Calendário para o Python do serviço, como já acontece com o Lembretes.

### B2 · Resumo do fim do dia · M
- Gatilho por voz ("Jarvis, fecha o dia") ou automático num horário do painel (padrão 18h30, respeitando o horário de silêncio).
- Conteúdo: e-mails importantes ainda sem resposta, compromissos que aconteceram, tarefas das outras IAs (feitas e com erro), lembretes vencidos e a agenda de amanhã com o primeiro horário.
- Usa a mesma máquina do briefing: roteiro falado com cartões sincronizados.
- Pode rodar o protocolo "Encerrar o dia" no fim.
- **Pronto quando:** às 18h30 ele fala o resumo com os cartões certos e salva uma cópia no Obsidian (pasta Jarvis/Diário).

### B3 · Responder e-mail · M
- Ferramenta `rascunhar_email` (para quem, assunto, texto) que cria um **rascunho** no Gmail pelo mesmo IMAP com senha de app que já existe. Não envia nada.
- Para responder, ele usa o e-mail original do briefing ("responde o Stripe…") e mantém a conversa no mesmo fio.
- Cartão com o rascunho para você revisar. Enviar continua sendo pelo Gmail.
- **Pronto quando:** o rascunho aparece no Gmail do celular, dentro da conversa certa.
- **Por que só rascunho:** enviar pede SMTP e é irreversível. Pode vir depois, sempre com confirmação.

### B4 · Modo reunião · G
- "Jarvis, modo reunião" grava o áudio da reunião pelo navegador. Se a call for no Chrome (Meet), grava o som da aba, que traz as duas vozes. Se não, grava só o microfone.
- Transcrição local com Whisper (o mesmo `mlx-whisper` usado para os vídeos de referência; roda no Mac, grátis).
- No fim, a Gemini de texto gera o resumo, as decisões e as tarefas com responsável. Ele cria os lembretes e salva a ata no Obsidian.
- **Pronto quando:** uma call de teste de 10 minutos vira uma ata com tarefas em até 2 minutos depois de encerrar.
- **Atenção:**
  - Avisar os participantes de que está gravando é responsabilidade sua; o HUD mostra um indicador.
  - Gravar Zoom pelo app (fora do Chrome) exige um driver de áudio como o BlackHole. Fica opcional.

---

## Onda C · Fora do Mac

### C1 · Acesso seguro (túnel + login) · M
- Túnel Cloudflare apontando para o Jarvis, com o Cloudflare Access na frente: só o seu e-mail entra, com código por e-mail. Sem porta aberta no roteador.
- O servidor continua ouvindo só em `127.0.0.1`. O túnel é a única porta de entrada.
- O endereço é HTTPS, condição para o navegador do celular liberar o microfone.
- Segue o guia `~/.config/claude-deploy/DEPLOY_PLAYBOOK.md` (o seu CLAUDE.md pede isso para Cloudflare).
- **Pronto quando:** no 4G, o endereço pede login e, depois dele, abre o HUD.
- **Custo:** o túnel e o Access são grátis para uso pessoal. Precisa de um domínio no Cloudflare (você já usa Cloudflare).
- **Decisão sua:** qual subdomínio usar.

### C2 · Celular como controle · M
- Página `/m`, feita para tela de celular:
  - botão grande de falar (segurar para falar);
  - a legenda e o último cartão;
  - atalhos para protocolos, câmeras e alertas;
  - instalável na tela inicial do iPhone (PWA).
- **De onde sai a voz:** a resposta sai no celular. Uma opção liga "falar pelo Mac" para usar o som da sala.
- **Avisos:** se o HUD do Mac estiver fechado, os avisos chegam no celular por notificação web (iOS com PWA instalado).
- **Pronto quando:** do quarto, pelo iPhone, "Jarvis, modo foco" funciona e a resposta vem falada no celular.

### C3 · Presença automática · P
- Com a presença ligada (câmera do HUD, já existe):
  - sem rosto por 10 minutos (ajustável): bloqueia as telas extras, pausa a música e baixa o brilho;
  - quando você volta e é reconhecido: "Bem-vindo de volta, Senhor. Chegaram dois e-mails e o Claude terminou a locução."
- A câmera só fica ligada se você ativar. O processamento é local e nada sai do Mac.
- **Pronto quando:** sair da mesa, voltar e ouvir o resumo do que chegou nesse meio-tempo.

---

## Onda D · Experiência

### D1 · Interromper sem fone · M
- Hoje o microfone fica mudo enquanto ele fala, para ele não ouvir a própria voz.
- O plano é ligar o cancelamento de eco do Chrome para a voz que toca na própria página e medir a qualidade.
- Se o eco sumir, "Interromper falando" passa a funcionar na caixa de som.
- Se não sumir o bastante, entra uma alternativa: só a palavra "Jarvis" (detectada no navegador) corta a fala dele.
- **Pronto quando:** você diz "Jarvis, para" no meio de uma fala dele, sem fone, e ele para em menos de 1 segundo.

### D2 · Animação de boot · P
- Na primeira abertura do dia: anéis se montam, cada serviço aparece checado (voz, memória, e-mail, agenda, câmeras), som de inicialização e "Bom dia, Senhor. Todos os sistemas operacionais."
- Pode emendar no briefing automático.
- **Pronto quando:** ligar o Mac de manhã e o HUD abrir com a sequência, uma vez por dia.

### D3 · Cartões manipuláveis · M
- Cartões fixos: você prende um cartão (clima, mercado, tarefa) num canto do HUD e ele fica até você soltar.
- Zoom na pinça: aproximar e afastar polegar e indicador sobre um gráfico do mercado muda o período (1 dia, 5 dias, 1 mês, 6 meses).
- Gesto de jogar o cartão para o lado já existe (fase 10). Falta o de puxar um cartão da fileira de volta ao centro.
- **Pronto quando:** dá para usar o mercado e os cartões só com a mão, sem mouse.

### D4 · Voz própria (opcional) · M
- Trocar a voz da Gemini por uma voz do ElevenLabs no estilo Jarvis (biblioteca ou clonada).
- **Troca envolvida:** a Gemini fala direto, com uma latência só. Com o ElevenLabs, o texto da Gemini vira áudio em outro serviço, o que acrescenta de 300 a 700 ms e gasta créditos.
- Proposta: usar a voz ElevenLabs só nos momentos de "palco" (boot, briefing, resumo do dia) e manter a Gemini na conversa.
- **Decisão sua:** se vale o custo em créditos.

---

## Onda E · Maestro

### E1 · Progresso ao vivo · M
- O Claude Code e o Codex rodam com saída em fluxo (`--output-format stream-json` e `--json`). O HUD mostra o passo atual de cada tarefa ("criando roteiro.md", "gerando áudio no ElevenLabs").
- Botão para abrir a pasta da tarefa no Finder; o cartão final mostra os arquivos criados.
- **Pronto quando:** dá para acompanhar uma tarefa do Claude passo a passo no painel lateral.

### E2 · Fila de projetos · G
- "Jarvis, toca o projeto lançamento da Nova Foods: roteiro, locução e post": a Gemini quebra o pedido em etapas com dependências e escolhe o agente de cada uma.
- A locução, por exemplo, espera o roteiro. As etapas rodam em ordem ou em paralelo, todas na mesma pasta de projeto.
- Relatório final falado e em cartão. Você confirma o plano antes de começar.
- **Pronto quando:** um pedido de 3 etapas termina sozinho, com os 3 arquivos na pasta e um relatório.

### E3 · Criar imagem e post · M
- Ferramenta `criar_imagem` com o modelo de imagem da Gemini. **Antes, conferir se ele tem cota no plano gratuito;** se não tiver, passa pelo Codex, que também gera imagens.
- "Jarvis, faz um post sobre…" gera imagem e legenda no mesmo cartão e salva os arquivos na pasta da tarefa.
- Para vídeo curto: delegar ao Claude Code com os skills de vídeo (HyperFrames) que você já tem instalados.
- **Pronto quando:** o pedido falado vira imagem e legenda em até 1 minuto.

---

## Onda F · Medição

### F1 · Painel de latência e cotas · P
- O painel Sistema mostra:
  - o tempo de cada ferramenta;
  - o tempo do fim da sua fala até a primeira palavra dele;
  - as reconexões da voz;
  - as chamadas por modelo no dia, comparadas com os limites do plano grátis.
- Aviso quando chegar a 80% de alguma cota.
- **Pronto quando:** fica claro qual ferramenta está deixando a resposta lenta.

---

## Decisões que preciso de você

1. **Domínio (C1):** qual subdomínio usar no túnel (ex.: `jarvis.seudominio.com`).
2. **Calendário (B1):** em qual calendário do Mac os eventos novos devem cair.
3. **Voz (D4):** usar o ElevenLabs só no "palco", sempre ou nunca.
4. **Reunião (B4):** suas calls são no Meet pelo Chrome ou também no app do Zoom.

## Riscos conhecidos

- **Permissões do macOS:** Calendário, microfone e Acesso Total ao Disco são pedidos para o Python do serviço. Cada permissão nova exige reiniciar o serviço (o botão já existe no painel).
- **Cotas grátis da Gemini:** o modo reunião e a fila de projetos usam mais o modelo de texto. O F1 mostra quando estiver perto do limite.
- **Celular no iOS:** notificação web só funciona com o PWA instalado na tela inicial. O áudio só toca depois do primeiro toque na página.
