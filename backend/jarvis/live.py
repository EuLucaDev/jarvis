"""Conversa por voz com a Gemini Live, com o microfone e o alto-falante do próprio núcleo (audio.py).

- Uma sessão só por vez; abre quando ele chama ("Jarvis", palmas, botão, texto) e dorme depois de 45 s quieta.
- Microfone mudo enquanto o Jarvis fala (sem fone o áudio voltaria), a menos que "interromper falando" esteja ligado.
- A legenda sai no ritmo do áudio: cada pedaço da transcrição aparece quando o alto-falante chega nele.
- Fase (espera, ouvindo, pensando, falando) e nível da voz vão para as telas 20 vezes por segundo (a esfera).
- No briefing, cada cartão aparece quando a fala chega no trecho dele.
"""

import asyncio
import logging
import time

from google import genai
from google.genai import types

from . import store, tools
from .audio import OUT_RATE, audio
from .config import settings
from .hub import hub
from .memory import memory

log = logging.getLogger("jarvis.live")

IDLE_S = 45  # sem conversa por esse tempo, a sessão dorme (o ouvido segue acordado)


def system_prompt() -> str:
    hoje = time.strftime("%d/%m/%Y, %H:%M")
    nome, chamar = settings.user_name, settings.chamar
    trato = f'Chame a pessoa de "{chamar}".' if chamar != nome else f"Chame a pessoa pelo nome, {nome}."
    return f"""Você é J.A.R.V.I.S., o assistente pessoal de {nome}. {trato} (Nas instruções abaixo, "ele" é essa pessoa.)
Fale sempre em português do Brasil, com voz calma, educada e um toque de humor seco britânico.
Agora são {hoje}. A cidade padrão é {settings.city}.

Como responder:
- Respostas faladas curtas: uma a três frases. Nada de listas faladas longas, nem ler links ou URLs.
- Você projeta cartões na tela dele (flutuam na área de trabalho e ele arruma com a mão ou o mouse).
  Quando a resposta tiver dados (números, comparações, notícias, fatos), pesquise e chame mostrar_pesquisa;
  fale só o principal. Passos, opções ou recomendações: mostrar_lista. Limpar: fechar_cartoes.
- Fatos atuais: pesquisar_web. A busca roda em segundo plano: diga numa frase curta que vai verificar e,
  quando chegar, responda e mostre o cartão.
- Clima: consultar_clima. Mercado: consultar_mercado. Ferramentas que já mostram cartão dispensam mostrar_pesquisa.
- "Bom dia" ou resumo do dia: briefing_bom_dia e leia o roteiro inteiro (os cartões aparecem sozinhos).
- Mensagens "[Ativação]": ele te chamou com você escondido. Cumprimente em uma frase, pelo horário.
- Mensagens "[Aviso do sistema": anuncie em uma frase, sem tratar como pergunta dele.
- Agenda, e-mails, notícias ou sistema em painel grande: abrir_painel (fechar com visao="fechar").
- Rotinas com nome ("modo foco", "protocolo X"): executar_protocolo.
- Sua própria janela: "se minimiza", "fica no canto", "some", "volta" → janela_jarvis.
- Janelas dos outros apps: "minimiza o navegador", "fecha essa janela", "põe o Chrome na esquerda",
  "maximiza", "manda pro outro monitor", "fecha o Spotify" → controlar_janela (fechar o app inteiro = sair,
  com confirmação). "Abre o X" → abrir_app. Faça na hora e confirme numa frase.
- Navegador: "pesquisa X" → navegador buscar (site se ele disser: YouTube, imagens, mapa…); "abre os
  resultados" → abrir_resultados; "lê/resume essa página" → ler_pagina e responda; trocar de aba,
  voltar, achar palavra na página, zoom → navegador.
- Arquivos e pastas: criar, ler/resumir, listar, abrir, renomear, mover, copiar, apagar (Lixeira, com
  confirmação) → arquivos. Para escrever um texto num arquivo novo, criar_arquivo com o conteúdo.
- Menus de um app ("Arquivo, Exportar como PDF") → usar_menu. Botões e links → clicar.
- Dinheiro (financeiro local dele): gasto ou entrada dito ("paguei 80 no mercado no crédito do Nubank",
  "recebi 3 mil de salário") → financeiro_lancar com a frase inteira, na hora, sem perguntar; confirme numa
  frase. "Quanto gastei / tenho / o que vence / como está o orçamento" → financeiro_consultar. Transferência
  entre contas dele → financeiro_transferir. Pagar conta ou fatura → financeiro_pagar (pede o sim). Metas e
  caixinhas → financeiro_meta. Extratos → financeiro_importar. "Desfaz" logo depois de um lançamento →
  financeiro_desfazer. "Abre o financeiro / os relatórios" → financeiro_abrir. Sem conta cadastrada, ofereça
  financeiro_cadastrar. Mensagem "[Fechamento do mês]": conduza o fechamento com financeiro_consultar fechamento.
- Automações: "toda segunda às 9 abre o e-mail e a agenda", "cria uma rotina de trabalho que…" → rotinas
  criar (diga antes o que ela fará). "Quais rotinas eu tenho" → rotinas listar.
- "Espelha minha tela", "olha minha tela", "compartilha a tela": espelhar_tela ligar. Com o espelho ligado
  você recebe a tela a cada 2 s: use isso para responder sobre o que ele está fazendo, sem pedir para ver.
- Câmera: "liga a câmera", "desliga a câmera" → camera. Com ela ligada você recebe imagens e ele usa as mãos.

Trabalhar junto no computador dele, à vista:
- Abrir: abrir_app, navegador (nova aba, buscar). Escrever: digitar (com app para trazer o app à frente).
  Atalhos: teclas. Botões e links pelo nome que aparece: clicar.
- "Isso", "aqui", "esse texto", "essa página": contexto_atual primeiro. Reescrever, traduzir ou corrigir o
  que está selecionado: contexto_atual e depois substituir_selecao.
- "Tá vendo essa barra lateral / esse canto / essa planilha": olhar (regiao ou alvo) ANTES de responder;
  você recebe a imagem. Responda como quem foi até lá ("Estou vendo, {chamar}…") e só então altere.
- Tarefa com 3 passos ou mais: mostrar_plano antes, atualizar_plano a cada passo, e narre curto.
- "Espera", "para": parar. "Continua": retome do passo em que parou.
- "Onde eu parei?": onde_parei. "Vou focar 50 minutos": modo_foco.
- Mensagens "[Sugestão aceita]": faça o que a sugestão pede.
- Trabalho grande ou criativo (arquivo, roteiro, áudio, arte, código, pesquisa longa): delegar_tarefa
  ("claude", "codex" ou "chatgpt"); claude e codex só com confirmado=true depois do sim.
- Nunca digite senhas nem dados de cartão.

Ações e segurança:
- Ao executar algo, confirme numa frase curta. Nunca diga que fez algo que não fez; erro vira explicação simples.
- Antes de apagar, organizar, enviar ou mudar algo importante, peça confirmação e espere o sim.
- Se não souber ou a busca não confirmar, diga isso. Nunca invente números.

Memória (um mapa: ele no centro, temas ligados a ele e memórias ligadas aos temas e entre si):
- Quando ele contar algo estável sobre si, pedir para lembrar ou te corrigir, chame lembrar com os temas
  certos (reuse os nomes de temas que já existem) ("anotado" basta).
- Antes de dizer que não sabe algo pessoal dele, chame buscar_memorias: ela já traz o que está ligado.
- "Mostre minha memória", "o que você sabe sobre mim/sobre X": mostrar_memoria (foco = o tema, se houver).
- Siga as correções e lições abaixo.

{_sistemas()}

O que você já sabe sobre ele, por tema:
{memory.prompt_block()}"""


def _sistemas() -> str:
    from . import sistemas

    return sistemas.prompt_bloco()


def build_config(handle: str | None) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_prompt(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=settings.voice))
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        tools=tools.todas(),
        context_window_compression=types.ContextWindowCompressionConfig(sliding_window=types.SlidingWindow()),
        session_resumption=types.SessionResumptionConfig(handle=handle),
    )


class Voice:
    """A sessão de voz (uma só) e o relógio que manda fase, nível e legenda para as telas."""

    def __init__(self) -> None:
        self.session = None
        self.handle: str | None = None
        self.task: asyncio.Task | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.mic: asyncio.Queue[bytes] | None = None
        self.sid: str | None = None
        self.user_buf = ""
        self.model_buf = ""
        self.awaiting_tool_reply = False
        self.tool_running = 0
        self.last_user = 0.0
        self.last_model = 0.0
        self.last_activity = 0.0
        self.turn_done = True
        self.pending_text: list[tuple[str, int]] = []  # pedaço da legenda e a amostra de áudio em que ele começa
        self.pending_ask: list[str] = []
        self.preroll: bytes = b""
        self.plan: list[tuple[int, str, dict]] = []
        self.plan_next = 0
        self.spoken_words = 0
        self.phase = "espera"

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    @property
    def live(self) -> bool:
        return self.session is not None

    # ---------- ligar e desligar ----------

    def bind(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        audio.subscribe(self._on_mic)
        loop.create_task(self._clock())

    def _on_mic(self, pcm: bytes) -> None:
        """Vem da linha do microfone (outra thread): só repassa enquanto a conversa está no ar."""
        if not self.live or not self.loop or not self.mic:
            return
        barge = (store.get("voz") or {}).get("interromper", False)
        if not barge and audio.playing():
            return  # sem fone, a voz dele voltaria pelo microfone
        self.loop.call_soon_threadsafe(self.mic.put_nowait, pcm)

    async def start(self, preroll: bytes = b"") -> None:
        if self.running:
            return
        if not settings.gemini_api_key:
            await hub.set_status(voice="error", error="Falta a chave da Gemini: abra a configuração inicial.")
            return
        self.preroll = preroll
        self.mic = asyncio.Queue(maxsize=400)
        self.sid = memory.start_session()
        self.last_activity = time.time()
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        t = self.task
        if t and t is not asyncio.current_task():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.task = None
        self.session = None
        self._flush_turn()
        if self.sid:
            asyncio.create_task(memory.reflect(self.sid))  # aprende com a conversa que acabou
            self.sid = None
        await hub.set_status(voice="off", error=None)

    async def ask(self, text: str) -> None:
        """Pedido por texto (painel, sugestão, "Jarvis, bom dia" de uma vez). Liga a sessão se precisar."""
        if self.live:
            await self.send_text(text)
        else:
            self.pending_ask.append(text)
            await self.start()

    async def send_text(self, text: str) -> None:
        if self.session:
            await hub.broadcast({"type": "user.text", "text": text, "typed": True})
            self.user_buf += " " + text
            self.last_user = self.last_activity = time.time()
            self.turn_done = False
            await self.session.send_realtime_input(text=text)

    async def send_image(self, jpeg: bytes) -> None:
        if self.session:
            await self.session.send_realtime_input(video=types.Blob(data=jpeg, mime_type="image/jpeg"))

    def _flush_turn(self) -> None:
        if self.sid and self.user_buf.strip():
            memory.log_turn(self.sid, "usuario", self.user_buf)
        if self.sid and self.model_buf.strip():
            memory.log_turn(self.sid, "jarvis", self.model_buf)
        self.user_buf = self.model_buf = ""

    # ---------- sessão ----------

    async def _run(self) -> None:
        client = genai.Client(api_key=settings.gemini_api_key)
        falhas = 0
        try:
            while True:
                await hub.set_status(voice="connecting", model=settings.live_model, error=None)
                try:
                    from . import sistemas

                    await sistemas.carregar_todos()  # ações dos sistemas conectados (WorkFlow etc.) entram na sessão
                    async with client.aio.live.connect(model=settings.live_model, config=build_config(self.handle)) as session:
                        self.session = session
                        falhas = 0
                        await hub.set_status(voice="live")
                        sender = asyncio.create_task(self._send_mic(session))
                        try:
                            if self.preroll:  # o que ele disse logo depois de "Jarvis", enquanto conectava
                                await session.send_realtime_input(audio=types.Blob(data=self.preroll, mime_type="audio/pcm;rate=16000"))
                                self.preroll = b""
                            while self.pending_ask:
                                await self.send_text(self.pending_ask.pop(0))
                            await self._pump(session)
                        finally:
                            sender.cancel()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    falhas += 1
                    log.warning("sessão de voz caiu: %s", exc)
                    await hub.set_status(voice="error", error=str(exc)[:300])
                    if falhas >= 3:
                        break
                    await asyncio.sleep(1.5 * falhas)
                finally:
                    self.session = None
        finally:
            self.session = None
        await self.stop()

    async def _send_mic(self, session) -> None:
        assert self.mic is not None
        while True:
            pcm = await self.mic.get()
            await session.send_realtime_input(audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000"))

    async def _pump(self, session) -> None:
        # receive() termina a cada turn_complete; o laço mantém a sessão escutando
        while True:
            async for msg in session.receive():
                if msg.session_resumption_update:
                    upd = msg.session_resumption_update
                    if upd.resumable and upd.new_handle:
                        self.handle = upd.new_handle
                if msg.go_away:
                    log.info("servidor pediu reconexão (go_away)")
                    return
                if msg.tool_call:
                    if any(fc.name not in tools.NON_BLOCKING for fc in msg.tool_call.function_calls or []):
                        self.awaiting_tool_reply = True
                    asyncio.create_task(self._tools(session, msg.tool_call))
                sc = msg.server_content
                if not sc:
                    continue
                if sc.interrupted:
                    audio.flush()
                    self.pending_text.clear()
                if sc.input_transcription and sc.input_transcription.text:
                    await self._user_text(sc.input_transcription.text)
                if sc.output_transcription and sc.output_transcription.text:
                    if self.turn_done:
                        self.pending_text.clear()
                    self.turn_done = False
                    self.model_buf += sc.output_transcription.text
                    self.last_model = self.last_activity = time.time()
                    # a legenda deste pedaço aparece quando o alto-falante chegar no áudio já enfileirado
                    self.pending_text.append((sc.output_transcription.text, audio.queued))
                if sc.model_turn:
                    for part in sc.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            self.awaiting_tool_reply = False
                            self.last_model = self.last_activity = time.time()
                            audio.enqueue(part.inline_data.data)
                if sc.turn_complete and self.awaiting_tool_reply:
                    continue
                if sc.turn_complete:
                    self.turn_done = True
                    self._flush_turn()

    async def _user_text(self, text: str) -> None:
        novo = self.turn_done or self.last_model > self.last_user
        self.last_user = self.last_activity = time.time()
        self.turn_done = False
        self.user_buf += text
        await hub.broadcast({"type": "user.text", "text": text, "novo": novo})

    async def _tools(self, session, call: types.LiveServerToolCall) -> None:
        responses = []
        self.tool_running += 1
        try:
            for fc in call.function_calls or []:
                await hub.broadcast({"type": "tool", "name": fc.name, "phase": "start"})
                result = await tools.run(fc.name, dict(fc.args or {}))
                image = result.pop("_imagem", None)
                if image:
                    await session.send_realtime_input(video=types.Blob(data=image, mime_type="image/jpeg"))
                await hub.broadcast({"type": "tool", "name": fc.name, "phase": "end"})
                sched = types.FunctionResponseScheduling.WHEN_IDLE if fc.name in tools.NON_BLOCKING else None
                responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=result, scheduling=sched))
        finally:
            self.tool_running -= 1
        if hub.pending_sequence:  # briefing: os cartões esperam a fala chegar no trecho deles
            self.plan, hub.pending_sequence = hub.pending_sequence, []
            self.plan_next = 0
            self.spoken_words = 0
            asyncio.create_task(self._finish_plan(self.plan))
        if responses and session is self.session:
            try:
                await session.send_tool_response(function_responses=responses)
            except Exception as exc:  # noqa: BLE001
                log.warning("resposta de ferramenta perdida: %s", exc)

    async def _finish_plan(self, plan: list) -> None:
        """Rede de segurança: o que a fala não liberou aparece depois de um tempo."""
        await asyncio.sleep(plan[-1][0] / 2.2 + 6)
        if self.plan is plan:
            for i in range(self.plan_next, len(plan)):
                await hub.show_card(plan[i][1], plan[i][2])
            self.plan = []

    # ---------- relógio: fase, nível, legenda ----------

    async def _clock(self) -> None:
        enviado = ("", -1.0, 0.0)  # fase, nível e quando mandou: em espera não precisa mandar 20 vezes por segundo
        while True:
            await asyncio.sleep(0.05)
            now = time.time()
            speaking = audio.playing()
            v = hub.status.get("voice")
            if v == "connecting":
                fase = "pensando"
            elif speaking:
                fase = "falando"
            elif not self.live:
                fase = "espera"
            elif self.tool_running or (not self.turn_done and self.last_user > self.last_model and now - self.last_user < 12):
                fase = "pensando"
            else:
                fase = "ouvindo"
            nivel = audio.level_out if fase == "falando" else audio.level_in if fase == "ouvindo" else 0.18 if fase == "pensando" else 0.03
            if speaking or audio.level_in > 0.12:
                self.last_activity = now
            if fase != self.phase:
                from . import ambient

                asyncio.create_task(ambient.apply(fase))  # luz ambiente (se ligada no painel)
            self.phase = fase

            # legenda: solta o que o alto-falante já alcançou (80 ms de folga)
            chunk = ""
            while self.pending_text and self.pending_text[0][1] <= audio.played + int(0.08 * OUT_RATE):
                chunk += self.pending_text.pop(0)[0]
            if not speaking and self.pending_text and now - self.last_model > 0.4:  # sem áudio (só texto): direto
                chunk += "".join(t for t, _ in self.pending_text)
                self.pending_text.clear()
            if chunk:
                await hub.broadcast({"type": "legenda", "texto": chunk})
                if self.plan:
                    self.spoken_words += len(chunk.split())
                    while self.plan_next < len(self.plan) and self.spoken_words >= self.plan[self.plan_next][0]:
                        _, kind, data = self.plan[self.plan_next]
                        self.plan_next += 1
                        await hub.show_card(kind, data)
            if fase != enviado[0] or abs(nivel - enviado[1]) > 0.01 or now - enviado[2] > 1:
                enviado = (fase, nivel, now)
                await hub.broadcast({"type": "vivo", "fase": fase, "nivel": round(float(nivel), 3), "ouvindo": round(float(audio.level_in), 3)})

            # dorme depois de um tempo quieta (a palavra "Jarvis" e as palmas seguem valendo)
            if self.live and not speaking and not self.tool_running and now - self.last_activity > IDLE_S:
                log.info("sessão de voz dormiu por inatividade")
                await self.stop()


voice = Voice()
