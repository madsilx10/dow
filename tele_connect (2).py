#!/usr/bin/env python3
"""Helper auto-confirm connect Telegram (Dow Protocol) pakai Pyrogram.

Dipanggil dow.js:  python3 tele_connect.py <session_string> <authorization_url>

Dua format authorization_url yang ditangani:
1. Link bot t.me/<bot>?start=<token>  -> kirim "/start <token>" ke bot.
2. oauth.telegram.org/auth?... (OIDC, format Dow) -> Seamless Telegram Login:
   messages.requestUrlAuth(url) -> (match code bila ada) ->
   messages.acceptUrlAuth(url) -> GET redirect URL (callback Dow).

Butuh: python3 + pyrogram (pip install pyrogram tgcrypto), dan file
tele_api.txt di folder yang sama (api_id baris 1, api_hash baris 2).
"""
import asyncio
import re
import sys
import urllib.parse
import urllib.request


def log(*a):
    print("[tele-py]", *a, flush=True)


def read_api_creds():
    api_id, api_hash = None, None
    try:
        lines = [l.strip() for l in open("tele_api.txt", encoding="utf8") if l.strip()]
        for l in lines:
            low = l.lower()
            if low.startswith("api_id"):
                api_id = int(re.sub(r"[^0-9]", "", l))
            elif low.startswith("api_hash"):
                api_hash = l.split(":", 1)[1].strip() if ":" in l else l.split("=", 1)[-1].strip()
        if api_id is None and len(lines) >= 2:
            api_id, api_hash = int(lines[0]), lines[1]
    except FileNotFoundError:
        pass
    return api_id, api_hash


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status, r.geturl()


async def seamless_login(app, url):
    """Konfirmasi login web Telegram via MTProto (requestUrlAuth/acceptUrlAuth)."""
    from pyrogram.raw import functions

    res = await app.invoke(functions.messages.RequestUrlAuth(url=url))
    log("requestUrlAuth:", type(res).__name__)
    match_codes = getattr(res, "match_codes", None)
    match_first = bool(getattr(res, "match_codes_first", False))
    log("match_codes:", match_codes, "| match_codes_first:", match_first)

    match_code = None
    if match_codes:
        # Cari kode yang benar: validasi tiap kandidat ke server.
        for code in match_codes:
            try:
                ok = await app.invoke(
                    functions.messages.CheckUrlAuthMatchCode(url=url, match_code=code)
                )
                log("checkMatchCode", repr(code), "->", ok)
                if ok:
                    match_code = code
                    break
            except Exception as e:
                log("checkMatchCode error:", e)
                break
        if match_code is None:
            match_code = match_codes[0]
            log("match_code fallback (kandidat pertama):", repr(match_code))

    kwargs = {"url": url, "write_allowed": True}
    if match_code is not None:
        kwargs["match_code"] = match_code
    acc = await app.invoke(functions.messages.AcceptUrlAuth(**kwargs))
    log("acceptUrlAuth:", type(acc).__name__)
    redirect = getattr(acc, "url", None)
    if redirect:
        log("redirect:", redirect[:200])
        status, final = http_get(redirect)
        log(f"callback GET -> HTTP {status} ({final[:120]})")
    log("OK seamless login diterima")
    return True


async def main():
    if len(sys.argv) < 3:
        log("usage: tele_connect.py <session_string> <url>")
        return
    session_string, url = sys.argv[1], sys.argv[2]
    log("URL:", url[:300])

    api_id, api_hash = read_api_creds()
    if not api_id or not api_hash:
        log("FAIL tele_api.txt tidak ada / format salah")
        return

    from pyrogram import Client

    app = Client(
        "dow_tele",
        api_id=api_id,
        api_hash=api_hash,
        session_string=session_string,
        in_memory=True,
    )
    async with app:
        me = await app.get_me()
        log(f"login sebagai @{me.username or me.id}")

        # Kasus 1: link bot t.me/<bot> (dengan atau tanpa ?start=<token>)
        m = re.search(r"t\.me/([^/?#]+)(?:\?start=([^&\s]+))?", url)
        if m:
            bot = m.group(1)
            token = urllib.parse.unquote(m.group(2)) if m.group(2) else ""
            await app.send_message(bot, f"/start {token}".strip())
            await asyncio.sleep(3)
            log(f"OK /start terkirim ke @{bot}")
            return

        # Kasus 2: oauth.telegram.org (OIDC) -> Seamless Login
        if "oauth.telegram.org" in url:
            try:
                await seamless_login(app, url)
            except Exception as e:
                log("FAIL seamless:", type(e).__name__, str(e)[:300])
                log("fallback: tap link manual di HP buat konfirmasi")
            return

        log("FAIL format URL tidak dikenal, tap manual:", url[:200])


if __name__ == "__main__":
    asyncio.run(main())
