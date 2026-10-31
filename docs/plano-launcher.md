# Plano: Jarvis Launcher (contas, instalação e atualização)

31/10/2026, a partir das respostas do Luca. É a base das próximas versões: acaba o "baixar o zip", cada pessoa tem
o seu Jarvis e as atualizações chegam sozinhas no launcher.

## Como fica

```
 jarvis.agcunae.com (VPS)
 ├─ site com login ─────────── baixar o launcher · painel do administrador
 ├─ loja de versões ─────────── arquivos de cada versão, por sistema (só baixa quem tem conta)
 └─ nuvem (portaria) ────────── um Jarvis na nuvem por conta: financeiro, memória, Telegram

 Computador da pessoa
 └─ Jarvis Launcher ─── entra com e-mail e senha → instala o Jarvis → avisa e aplica as atualizações
     └─ Jarvis ──────── já vem ligado à nuvem da conta e com o código do Telegram
```

## Decisões (respostas do Luca)

| Tema | Decisão |
|---|---|
| Contas | **Uma conta só para tudo**: a conta do site é o Jarvis na nuvem da pessoa (financeiro, memória, Telegram). |
| Gemini | **Cada um usa a sua chave**: a configuração inicial pede a chave e o Jarvis manda para a nuvem da conta. |
| Atualizações | **Aparecem no launcher e a pessoa clica**; só baixa os arquivos que mudaram. |
| Endereço | **jarvis.agcunae.com** (o site na página principal; a nuvem continua por trás). |
| Administrador | O Luca, com e-mail e senha definidos por ele (troca recomendada no primeiro acesso). |
| Painel do admin | Criar, pausar e apagar contas; ver quem instalou, em qual sistema, qual versão e quando usou. |
| O que já existe | **Começar do zero**: os perfis de teste da nuvem (Luca e Ana) saem, com backup antes. O financeiro do notebook do Luca continua no Mac dele e pode ser enviado de novo. |
| Mac | O Jarvis fica em **/Applications**, com a assinatura "Jarvis Local", para as permissões não caírem a cada atualização. |

## Peças

### 1. Site e contas (na portaria)
- Login por e-mail e senha (senha guardada com scrypt; sessão em cookie seguro).
- Conta nova: o admin informa nome e e-mail; o site gera um **link de primeiro acesso** (vale 7 dias) para a pessoa
  criar a senha. Junto nasce o Jarvis na nuvem dela.
- Admin: lista de contas (ativa ou pausada, sistema, versão instalada, último uso), criar, pausar (o launcher e a
  nuvem param de aceitar), apagar (conta e dados da nuvem, com confirmação digitando o e-mail) e o token do robô do
  Telegram (um robô para todos).
- Pessoa comum: baixar o launcher para o sistema dela, trocar a senha e ver o código do Telegram.

### 2. Loja de versões
- A compilação automática (GitHub, só para compilar) monta cada sistema e manda para a loja na VPS: um **manifesto**
  por sistema (cada arquivo com o seu hash) e os arquivos guardados pelo hash no R2 (bucket privado `jarvis-versoes`).
- Arquivo que não mudou não sobe de novo nem é baixado de novo: a atualização traz só o que mudou e apaga o que saiu.
- A portaria registra as versões (número, data, o que mudou) e só entrega arquivos para quem está logado e ativo.

### 3. Jarvis Launcher (app pequeno, Tauri)
- Instaladores do launcher (Mac, Windows, Linux) baixados no site.
- Entra com e-mail e senha (fica guardado no chaveiro do sistema), descobre o sistema e oferece **Instalar Jarvis**.
- Instala em /Applications (Mac), na pasta de programas do usuário (Windows, sem pedir administrador) ou em
  ~/.local (Linux, com atalho no menu).
- **Atualização disponível**: mostra o que mudou e o tamanho real do download; aplica numa cópia ao lado e troca
  de uma vez (se algo falhar no meio, o Jarvis atual continua intacto). Fecha o Jarvis antes de trocar e abre depois.
- O launcher se atualiza sozinho do mesmo jeito.
- Conta pausada ou apagada: o launcher avisa e não atualiza mais.

### 4. Jarvis já ligado
- Ao instalar, o launcher deixa a ligação com a nuvem pronta (endereço, perfil e um acesso só daquele computador).
- Na configuração inicial: nome, cidade, voz e a chave da Gemini da pessoa (que sobe para a nuvem dela).
- Telegram: o robô é um só e já vem configurado; cada pessoa tem o seu código. Um botão "Abrir no Telegram" (no
  launcher e no painel do Jarvis) abre o robô já com o código, e a conversa fica ligada àquela conta.
- O Jarvis informa a versão e o sistema para o painel do admin.

## Fases

| Fase | Entrega |
|---|---|
| 1 | Contas e site: login, admin, links de primeiro acesso, pausar e apagar; conta = perfil na nuvem; começar do zero |
| 2 | Loja de versões: manifesto e arquivos por hash no R2, envio pela compilação automática, registro das versões |
| 3 | Launcher: login, instalar, atualizar só o que mudou, abrir o Jarvis, se atualizar sozinho |
| 4 | Jarvis já ligado à nuvem e ao Telegram pelo launcher; versão e sistema no painel |
| 5 | Instaladores do launcher no site e o fim do zip |

## Cuidados
- Pausar ou apagar conta corta o acesso na hora: launcher, nuvem e Telegram.
- Ninguém vê os dados de ninguém, nem o admin: o painel mostra só conta, sistema, versão e último uso.
- O instalador do launcher no Mac não é assinado pela Apple (sem conta paga): na primeira vez, Ajustes → Privacidade
  e Segurança → "Abrir Mesmo Assim". Depois disso, o launcher cuida de tudo.
- Os arquivos das versões ficam no R2 privado do Luca, servidos só pela portaria para contas ativas.
