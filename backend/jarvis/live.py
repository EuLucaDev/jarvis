"""Ponte entre o microfone do navegador e a Gemini Live.

O navegador manda PCM 16 kHz em frames binários; a Gemini responde PCM 24 kHz, que volta só
para o navegador que está com o microfone. Transcrições, estados e cartões vão para todas as telas.
"""

import asyncio
import logging
import time

from fastapi import WebSocket
from google import genai
from google.genai import types

from . import tools
from .config import settings
from .hub import hub
from .memory import memory

log = logging.getLogger("jarvis.live")


def system_prompt() -> str:
    hoje = time.strftime("%d/%m/%Y, %H:%M")
    return f"""Você é J.A.R.V.I.S., o assistente pessoal de {settings.user_name}. Chame-o de "Senhor".
Fale sempre em português do Brasil, com voz calma, educada e um toque de humor seco britânico.
Agora são {hoje}. A cidade padrão é {settings.city}.

Como responder:
- Respostas faladas curtas: uma a três frases. Nada de listas faladas longas, nem ler links ou URLs.
- Você tem uma tela. Quando a resposta tiver dados (números, comparações, notícias, fatos
  verificáveis), pesquise e chame mostrar_pesquisa com os detalhes; fale só o principal.
- Para fatos atuais, chame pesquisar_web antes de responder.
- Clima: chame consultar_clima. Passos, opções ou recomendações: chame mostrar_lista.
- Para limpar a tela, chame fechar_cartoes.
- "Bom dia" ou pedido de resumo do dia: chame briefing_bom_dia e leia o roteiro inteiro.
- Telas extras: ativar_telas. Computador: abrir_app, abrir_link, controlar_midia, ajustar_volume.
- Celular, casa, Alexa e automações: executar_atalho (Atalhos do macOS liberados por ele).
- Câmeras: ver_camera, depois descreva o que vê em uma ou duas frases.
- Casa pela Alexa: controlar_casa. Lembretes (vão para o iPhone): criar_lembrete.
- Arquivos e pastas: arquivos. Mercado e cotações: consultar_mercado.
- Ferramentas que já mostram cartão (clima, mercado, briefing, câmera) dispensam mostrar_pesquisa: um cartão por resposta.
- Mensagens do iPhone (iMessage): ler_mensagens; para enviar, enviar_mensagem com confirmação.
- Notas (Obsidian e Notion): notas. Saúde (passos, sono, treinos): consultar_saude.
- Mensagens que começam com "[Aviso do sistema" são alertas: anuncie em uma frase, sem tratar como pergunta dele.
- Quando ele ligar a câmera ou compartilhar a tela, você recebe imagens: use para responder sobre o que vê.

Ações e segurança:
- Ao executar algo, confirme numa frase curta ("Feito, Senhor. A luz da sala está ligada.").
- Nunca diga que fez algo que não fez. Se a ferramenta devolver erro, conte o erro em linguagem simples.
- Antes de apagar, organizar, enviar ou mudar algo importante, peça confirmação e espere o sim.
- Se não souber ou a busca não confirmar, diga isso. Nunca invente números.

Memória:
- Você aprende sobre ele com o tempo. Quando ele contar algo estável sobre si, pedir para lembrar
  ou corrigir você, chame lembrar (sem anunciar demais; um "anotado" basta).
- Antes de dizer que não sabe algo pessoal dele, chame buscar_memorias.
- Siga as correções e lições abaixo: são aprendizados de conversas anteriores.

O que você já sabe sobre ele:
{memory.prompt_block()}"""


def build_config(handle: str | None) -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        system_instruction=system_prompt(),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=settings.voice)
            )
        ),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        output_audio_transcription=types.AudioTranscriptionConfig(),
        tools=tools.TOOLS,
        context_window_compression=types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        ),
        session_resumption=types.SessionResumptionConfig(handle=handle),
    )


class VoiceBridge:
    """Uma sessão de voz ligada a um navegador (o que tem o microfone)."""

    def __init__(self, ws: WebSocket) -> None:
        self.ws = ws
        self.session = None
        self.handle: str | None = None
        self.task: asyncio.Task | None = None
        self.active = False
        self.sid: str | None = None
        self.user_buf = ""
        self.model_buf = ""
        self.awaiting_tool_reply = False  # depois de uma ferramenta vem um turno vazio; não é o fim
        self.last_audio_at = 0.0  # transcrição sem áudio recente é ruído (ex.: "jugar" sem microfone)
        self.plan: list[tuple[int, str, dict]] = []  # cartões do briefing, liberados pelo HUD
        self.plan_shown: set[int] = set()
        self.plan_t0 = 0.0

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    async def start(self) -> None:
        if self.running:
            return
        if not settings.gemini_api_key:
            await hub.set_status(voice="error", error="Falta GEMINI_API_KEY no arquivo .env.")
            return
        self.active = True
        self.sid = memory.start_session()
        self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self.active = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self.session = None
        self._flush_turn()
        if self.sid:
            asyncio.create_task(memory.reflect(self.sid))  # aprende com a conversa que acabou
            self.sid = None
        await hub.set_status(voice="off", error=None)

    async def show_planned(self, index: int) -> None:
        if 0 <= index < len(self.plan) and index not in self.plan_shown:
            self.plan_shown.add(index)
            _, kind, data = self.plan[index]
            await hub.show_card(kind, data)

    async def _finish_plan(self, plan: list) -> None:
        """Rede de segurança: se o HUD não pediu algum cartão (aba escondida), mostra depois da fala."""
        elapsed = asyncio.get_running_loop().time() - self.plan_t0
        await asyncio.sleep(max(0.0, plan[-1][0] / 2.2 - elapsed) + 4)
        if self.plan is plan:
            for i in range(len(plan)):
                await self.show_planned(i)
            self.plan = []

    def _flush_turn(self) -> None:
        if self.sid and self.user_buf.strip():
            memory.log_turn(self.sid, "usuario", self.user_buf)
        if self.sid and self.model_buf.strip():
            memory.log_turn(self.sid, "jarvis", self.model_buf)
        self.user_buf = self.model_buf = ""

    async def send_audio(self, pcm: bytes) -> None:
        if self.session:
            self.last_audio_at = time.time()
            await self.session.send_realtime_input(
                audio=types.Blob(data=pcm, mime_type="audio/pcm;rate=16000")
            )

    async def send_image(self, jpeg: bytes) -> None:
        """Quadro da câmera ou da tela (até ~1 por segundo) para o modelo ver."""
        if self.session:
            await self.session.send_realtime_input(video=types.Blob(data=jpeg, mime_type="image/jpeg"))

    async def send_text(self, text: str) -> None:
        if self.session:
            await hub.broadcast({"type": "user.text", "text": text, "typed": True})
            self.user_buf += " " + text
            await self.session.send_realtime_input(text=text)

    async def _run(self) -> None:
        client = genai.Client(api_key=settings.gemini_api_key)
        failures = 0
        while self.active:
            await hub.set_status(voice="connecting", model=settings.live_model, error=None)
            try:
                async with client.aio.live.connect(
                    model=settings.live_model, config=build_config(self.handle)
                ) as session:
                    self.session = session
                    failures = 0
                    await hub.set_status(voice="live")
                    await self._pump(session)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                failures += 1
                log.warning("sessão de voz caiu: %s", exc)
                await hub.set_status(voice="error", error=str(exc)[:300])
                if failures >= 3:
                    self.active = False
                    break
                await asyncio.sleep(1.5 * failures)
            finally:
                self.session = None

    async def _pump(self, session) -> None:
        # receive() termina a cada turn_complete; o laço externo mantém a sessão escutando.
        while self.active:
            async for msg in session.receive():
                if msg.session_resumption_update:
                    upd = msg.session_resumption_update
                    if upd.resumable and upd.new_handle:
                        self.handle = upd.new_handle
                if msg.go_away:
                    log.info("servidor pediu reconexão (go_away)")
                    return
                if msg.tool_call:
                    await self._tools(session, msg.tool_call)
                sc = msg.server_content
                if not sc:
                    continue
                if sc.interrupted:
                    await self.ws.send_json({"type": "audio.flush"})
                    await hub.broadcast({"type": "turn", "phase": "interrupted"})
                heard = time.time() - self.last_audio_at < 5
                if sc.input_transcription and sc.input_transcription.text and heard:
                    await hub.broadcast({"type": "user.text", "text": sc.input_transcription.text})
                    self.user_buf += sc.input_transcription.text
                if sc.output_transcription and sc.output_transcription.text:
                    await hub.broadcast({"type": "model.text", "text": sc.output_transcription.text})
                    self.model_buf += sc.output_transcription.text
                if sc.model_turn:
                    for part in sc.model_turn.parts or []:
                        if part.inline_data and part.inline_data.data:
                            self.awaiting_tool_reply = False
                            await self.ws.send_bytes(part.inline_data.data)
                if sc.turn_complete and self.awaiting_tool_reply:
                    continue
                if sc.turn_complete:
                    if self.plan:
                        asyncio.create_task(self._finish_plan(self.plan))
                    self._flush_turn()
                    await hub.broadcast({"type": "turn", "phase": "complete"})

    async def _tools(self, session, call: types.LiveServerToolCall) -> None:
        responses = []
        for fc in call.function_calls or []:
            await hub.broadcast({"type": "tool", "name": fc.name, "phase": "start"})
            result = await tools.run(fc.name, dict(fc.args or {}))
            image = result.pop("_imagem", None)
            if image:  # câmera: o modelo também vê a imagem
                await session.send_realtime_input(video=types.Blob(data=image, mime_type="image/jpeg"))
            await hub.broadcast({"type": "tool", "name": fc.name, "phase": "end"})
            responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response=result))
        if hub.pending_sequence:
            # O HUD conta as palavras exibidas na legenda e pede cada cartão na hora certa.
            self.plan, hub.pending_sequence = hub.pending_sequence, []
            self.plan_shown = set()
            self.plan_t0 = asyncio.get_running_loop().time()
            await self.ws.send_json({"type": "sequence.plan", "palavras": [w for w, _, _ in self.plan]})
        if responses:
            self.awaiting_tool_reply = True
            await session.send_tool_response(function_responses=responses)
