"""iMessage/SMS pelo app Mensagens do Mac. Grátis, local.

Ler exige "Acesso Total ao Disco" para o Python que roda o Jarvis (o macOS protege o chat.db).
Enviar usa o app Mensagens por AppleScript e sempre passa por confirmação do usuário.
"""

import datetime as dt
import glob
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from typing import Any

CHAT_DB = Path.home() / "Library" / "Messages" / "chat.db"
AB_GLOB = str(Path.home() / "Library" / "Application Support" / "AddressBook" / "Sources" / "*" / "AddressBook-v22.abcddb")
APPLE_EPOCH = dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)

NO_ACCESS = (
    "Sem acesso às Mensagens. Em Ajustes do Sistema → Privacidade e Segurança → Acesso Total ao Disco, "
    f"adicione {Path(sys.executable).resolve()} e reinicie o Jarvis."
)


def has_access() -> bool:
    try:
        con = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
        con.execute("select 1 from message limit 1")
        con.close()
        return True
    except sqlite3.Error:
        return False


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")[-9:]


def contacts() -> dict[str, str]:
    """Telefone (últimos 9 dígitos) ou e-mail -> nome."""
    out: dict[str, str] = {}
    for db in glob.glob(AB_GLOB):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute(
                """select coalesce(r.ZFIRSTNAME,'') || ' ' || coalesce(r.ZLASTNAME,''), r.ZORGANIZATION, p.ZFULLNUMBER, e.ZADDRESS
                   from ZABCDRECORD r
                   left join ZABCDPHONENUMBER p on p.ZOWNER = r.Z_PK
                   left join ZABCDEMAILADDRESS e on e.ZOWNER = r.Z_PK"""
            ).fetchall()
            con.close()
        except sqlite3.Error:
            continue
        for name, org, phone, mail in rows:
            label = " ".join(name.split()) or (org or "")
            if not label:
                continue
            if phone:
                out[_digits(phone)] = label
            if mail:
                out[mail.lower()] = label
    return out


def _text(text: str | None, body: bytes | None) -> str:
    if text:
        return text
    if not body:
        return ""
    # attributedBody (typedstream): o texto vem logo depois de "NSString", com tamanho prefixado
    try:
        chunk = body.split(b"NSString", 1)[1][5:]
        if chunk[0] == 0x81:
            n = int.from_bytes(chunk[1:3], "little")
            return chunk[3 : 3 + n].decode("utf-8", "replace")
        return chunk[1 : 1 + chunk[0]].decode("utf-8", "replace")
    except (IndexError, ValueError):
        return ""


def recent(nao_lidas: bool = True, limite: int = 15, de: str | None = None) -> dict[str, Any]:
    if not has_access():
        return {"erro": NO_ACCESS}
    names = contacts()
    con = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
    rows = con.execute(
        f"""select m.text, m.attributedBody, m.date, m.is_read, h.id, c.display_name
            from message m
            left join handle h on m.handle_id = h.ROWID
            left join chat_message_join cmj on cmj.message_id = m.ROWID
            left join chat c on c.ROWID = cmj.chat_id
            where m.is_from_me = 0 and m.item_type = 0 {'and m.is_read = 0' if nao_lidas else ''}
            order by m.date desc limit 200"""
    ).fetchall()
    con.close()
    out = []
    for text, body, date, is_read, handle, group in rows:
        msg = _text(text, body).replace("￼", "").strip()
        if not msg:
            continue
        who = names.get(_digits(handle or "")) or names.get((handle or "").lower()) or handle or "Desconhecido"
        if de and de.lower() not in who.lower() and de.lower() not in (group or "").lower():
            continue
        when = APPLE_EPOCH + dt.timedelta(seconds=date / 1e9 if date > 1e12 else date)
        out.append({
            "de": who,
            "grupo": group or None,
            "texto": msg[:500],
            "quando": when.astimezone().strftime("%d/%m %H:%M"),
            "lida": bool(is_read),
        })
        if len(out) >= limite:
            break
    total = len(out)
    return {"total": total, "mensagens": out}


def resolve(para: str) -> list[tuple[str, str]]:
    """Nome ou número -> lista de (nome, endereço) possíveis."""
    if re.fullmatch(r"[+\d\s()-]{8,}", para.strip()):
        return [(para.strip(), re.sub(r"[^\d+]", "", para))]
    hits: dict[str, str] = {}
    for db in glob.glob(AB_GLOB):
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
            rows = con.execute(
                """select coalesce(r.ZFIRSTNAME,'') || ' ' || coalesce(r.ZLASTNAME,''), p.ZFULLNUMBER
                   from ZABCDRECORD r join ZABCDPHONENUMBER p on p.ZOWNER = r.Z_PK"""
            ).fetchall()
            con.close()
        except sqlite3.Error:
            continue
        for name, phone in rows:
            name = " ".join(name.split())
            if name and para.lower() in name.lower() and phone:
                hits.setdefault(name, re.sub(r"[^\d+]", "", phone))
    return list(hits.items())[:5]


def send(para: str, texto: str, confirmado: bool = False) -> dict[str, Any]:
    alvos = resolve(para)
    if not alvos:
        return {"erro": f"Não achei '{para}' nos contatos." + ("" if has_access() else " " + NO_ACCESS)}
    if len(alvos) > 1:
        return {"precisa_escolher": [n for n, _ in alvos], "instrucao": "Pergunte para qual destes ele quer enviar."}
    nome, endereco = alvos[0]
    if not confirmado:
        return {
            "precisa_confirmar": True,
            "para": nome,
            "texto": texto,
            "instrucao": "Leia para ele o destinatário e a mensagem e pergunte se pode enviar. Só repita com confirmado=true depois do sim.",
        }
    esc = texto.replace("\\", "\\\\").replace('"', '\\"')
    script = [
        'tell application "Messages"',
        "set s to 1st account whose service type = iMessage",
        f'send "{esc}" to participant "{endereco}" of s',
        "end tell",
    ]
    r = subprocess.run(["osascript", *sum((["-e", x] for x in script), [])], capture_output=True, text=True, timeout=20)
    if r.returncode != 0:
        return {"erro": r.stderr.strip()[:200]}
    return {"ok": True, "enviado_para": nome}
