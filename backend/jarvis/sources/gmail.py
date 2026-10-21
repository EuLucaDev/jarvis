"""Gmail por IMAP com senha de app (myaccount.google.com/apppasswords). Só leitura."""

import datetime as dt
import email
import email.header
import email.utils
import imaplib
import re
from typing import Any


def _dec(value: str | None) -> str:
    if not value:
        return ""
    parts = []
    for text, enc in email.header.decode_header(value):
        parts.append(text.decode(enc or "utf-8", "replace") if isinstance(text, bytes) else text)
    return " ".join("".join(parts).split())


def _snippet(msg: email.message.Message) -> str:
    for part in msg.walk() if msg.is_multipart() else [msg]:
        ctype = part.get_content_type()
        if ctype in ("text/plain", "text/html") and not part.get_filename():
            raw = part.get_payload(decode=True) or b""
            text = raw.decode(part.get_content_charset() or "utf-8", "replace")
            if ctype == "text/html":
                text = re.sub(r"<(style|script)[^>]*>.*?</\1>", " ", text, flags=re.S | re.I)
                text = re.sub(r"<[^>]+>", " ", text)
            text = " ".join(text.split())
            if text:
                return text[:400]
    return ""


def fetch(account: dict[str, str], hours: int = 24, limit: int = 25) -> dict[str, Any]:
    """E-mails não lidos das últimas `hours` horas da caixa de entrada."""
    box = imaplib.IMAP4_SSL("imap.gmail.com", timeout=20)
    try:
        box.login(account["email"], account["senha_app"].replace(" ", ""))
        box.select("INBOX", readonly=True)
        since = (dt.datetime.now() - dt.timedelta(hours=hours)).strftime("%d-%b-%Y")
        _, data = box.search(None, f"(UNSEEN SINCE {since})")
        ids = data[0].split()
        out = []
        for mid in reversed(ids[-limit:]):
            _, parts = box.fetch(mid, "(BODY.PEEK[])")
            raw = next((p[1] for p in parts if isinstance(p, tuple)), None)
            if not raw:
                continue
            msg = email.message_from_bytes(raw)
            name, addr = email.utils.parseaddr(_dec(msg.get("From")))
            when = email.utils.parsedate_to_datetime(msg.get("Date")) if msg.get("Date") else None
            out.append({
                "conta": account["email"],
                "de": name or addr,
                "endereco": addr,
                "assunto": _dec(msg.get("Subject")) or "(sem assunto)",
                "data": when.strftime("%d/%m %H:%M") if when else "",
                "trecho": _snippet(msg),
            })
        return {"total": len(ids), "emails": out}
    finally:
        try:
            box.logout()
        except Exception:  # noqa: BLE001
            pass
