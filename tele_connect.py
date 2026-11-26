#!/usr/bin/env python3
"""Helper connect Telegram (Dow Protocol) pakai Pyrogram.

Dipanggil dow.js:  python3 tele_connect.py <session_string> <authorization_url>

Jalur utama (flow nomor HP oauth.telegram.org):
  1. Ambil nomor HP dari session Pyrogram.
  2. POST /auth/request {phone} -> Telegram kirim prompt konfirmasi ke app.
  3. Poll /auth/login?qtoken= sampai 'consumed' (user tap Confirm di app).
  4. GET quick_auth -> redirect ke callback Dow.
Selama menunggu, semua update MTProto yang masuk di-log (buat riset jalur auto).

Juga menangani link bot t.me/<bot>?start=<token> (kirim /start).

Butuh: python3 + pyrogram (pip install pyrogram tgcrypto), dan file
tele_api.txt di folder yang sama (api_id baris 1, api_hash baris 2).
"""
import asyncio
import http.cookiejar
import json
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


class Http:
    def __init__(self):
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )

    def get(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with self.opener.open(req, timeout=30) as r:
            return r.status, r.geturl(), r.read()

    def post(self, url, referer, data=None):
        body = urllib.parse.urlencode(data or {}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            method="POST",
            headers={
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": referer,
            },
        )
        with self.opener.open(req, timeout=30) as r:
            return r.read().decode("utf8", "replace")

    def post_json(self, url, referer, data=None):
        body = self.post(url, referer, data)
        try:
            return json.loads(body)
        except Exception:
            return {"_raw": body[:300]}


def build_qs(auth_url):
    p = urllib.parse.parse_qs(urllib.parse.urlparse(auth_url).query)

    def one(k):
        return p.get(k, [""])[0]

    redirect_uri = one("redirect_uri")
    origin = ""
    if redirect_uri:
        u = urllib.parse.urlparse(redirect_uri)
        origin = f"{u.scheme}://{u.netloc}"
    pairs = [
        ("client_id", one("client_id")),
        ("origin", origin),
        ("return_to", redirect_uri),
        ("state", one("state")),
        ("scope", one("scope")),
        ("redirect_uri", redirect_uri),
        ("code_challenge", one("code_challenge")),
        ("code_challenge_method", one("code_challenge_method")),
        ("response_type", one("response_type")),
        ("nonce", one("nonce")),
    ]
    return urllib.parse.urlencode(pairs)


def _tl_string(s):
    b = s.encode("utf-8")
    if len(b) <= 253:
        pad = (4 - (len(b) + 1) % 4) % 4
        return bytes([len(b)]) + b + b"\x00" * pad
    pad = (4 - (len(b) + 4) % 4) % 4
    return b"\xfe" + len(b).to_bytes(3, "little") + b + b"\x00" * pad


def _make_new_layer_classes():
    """Konstruktor layer 225 buat Pyrogram lama yang belum punya in_app_origin."""
    import struct
    from pyrogram.raw.core import TLObject

    class RequestUrlAuthNew(TLObject):
        ID = 0x894CC99C
        QUALNAME = "functions.messages.RequestUrlAuth"

        def __init__(self, url, in_app_origin=None):
            self.url = url
            self.in_app_origin = in_app_origin

        def write(self):
            flags = 4  # url
            if self.in_app_origin:
                flags |= 8
            out = struct.pack("<I", self.ID) + struct.pack("<I", flags) + _tl_string(self.url)
            if self.in_app_origin:
                out += _tl_string(self.in_app_origin)
            return out

        @staticmethod
        def read(b, *args):
            return RequestUrlAuthNew(url="")

    class AcceptUrlAuthNew(TLObject):
        ID = 0x67A3F0DE
        QUALNAME = "functions.messages.AcceptUrlAuth"

        def __init__(self, url, match_code=None):
            self.url = url
            self.match_code = match_code

        def write(self):
            flags = 1 | 4  # write_allowed + url
            if self.match_code:
                flags |= 16
            out = struct.pack("<I", self.ID) + struct.pack("<I", flags) + _tl_string(self.url)
            if self.match_code:
                out += _tl_string(self.match_code)
            return out

        @staticmethod
        def read(b, *args):
            return AcceptUrlAuthNew(url="")

    return RequestUrlAuthNew, AcceptUrlAuthNew


async def _accept_flow(app, form, r, accept_fn):
    """Dari hasil requestUrlAuth -> acceptUrlAuth. Return (kind, redirect)."""
    from pyrogram.raw import functions

    if type(r).__name__ == "UrlAuthResultAccepted":
        return ("accepted", getattr(r, "url", None))
    if type(r).__name__ != "UrlAuthResultRequest":
        return (None, None)
    match_codes = getattr(r, "match_codes", None)
    match_first = bool(getattr(r, "match_codes_first", False))
    log("match_codes:", match_codes, "| first:", match_first)
    match_code = None
    if match_codes and match_first:
        for code in match_codes:
            try:
                ok = await app.invoke(
                    functions.messages.CheckUrlAuthMatchCode(url=form, match_code=code)
                )
                log("checkMatchCode", repr(code), "->", ok)
                if ok:
                    match_code = code
                    break
            except Exception as e:
                log("checkMatchCode error:", str(e)[:120])
                break
    if match_codes and not match_code:
        match_code = match_codes[0]
    acc = await accept_fn(form, match_code)
    log("acceptUrlAuth ->", type(acc).__name__)
    return ("accepted", getattr(acc, "url", None))


async def try_mtproto_accept(app, token, auth_url=None):
    """Coba terima login via MTProto pakai token segar dari poll refresh."""
    from pyrogram.raw import functions
    import base64

    forms = [
        f"https://t.me/oauth?startapp={token}",
        f"tg://oauth?token={token}",
        f"tg://resolve?domain=oauth&startapp={token}",
    ]

    async def builtin_accept(form, match_code):
        kwargs = {"url": form, "write_allowed": True}
        if match_code is not None:
            kwargs["match_code"] = match_code
        return await app.invoke(functions.messages.AcceptUrlAuth(**kwargs))

    # 1) konstruktor bawaan Pyrogram
    for form in forms:
        try:
            r = await app.invoke(functions.messages.RequestUrlAuth(url=form))
            log("requestUrlAuth:", form[:60], "->", type(r).__name__)
            kind, redirect = await _accept_flow(app, form, r, builtin_accept)
            if kind:
                return (kind, redirect)
        except Exception as e:
            log("requestUrlAuth gagal:", form[:60], "->", str(e)[:100])

    # 2) konstruktor layer 225 (buat Pyrogram lama)
    try:
        ReqNew, AccNew = _make_new_layer_classes()

        async def new_accept(form, match_code):
            return await app.invoke(AccNew(url=form, match_code=match_code))

        for form in forms:
            for origin in [None, "https://oauth.telegram.org"]:
                try:
                    r = await app.invoke(ReqNew(url=form, in_app_origin=origin))
                    log("requestUrlAuth[225]:", form[:50], "| origin:", origin, "->", type(r).__name__)
                    kind, redirect = await _accept_flow(app, form, r, new_accept)
                    if kind:
                        return (kind, redirect)
                except Exception as e:
                    log("requestUrlAuth[225] gagal:", form[:50], "| origin:", origin, "->", str(e)[:100])
    except Exception as e:
        log("konstruktor 225 tidak tersedia:", str(e)[:120])

    # 3) login token?
    for label, raw in [
        ("b64url", base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))),
        ("raw", token.encode()),
    ]:
        try:
            acc = await app.invoke(functions.auth.AcceptLoginToken(token=raw))
            log(f"acceptLoginToken[{label}] ->", type(acc).__name__)
            return ("login_token", None)
        except Exception as e:
            log(f"acceptLoginToken[{label}] gagal:", str(e)[:110])
    return (None, None)


async def phone_login(app, me, auth_url):
    http = Http()
    qs = build_qs(auth_url)
    phone_page = f"https://oauth.telegram.org/auth/auth?{qs}&phone_login=1"

    status, _, body = http.get(phone_page)
    log("GET phone page ->", status)
    html = body.decode("utf8", "replace")
    m = re.search(r"ajax\('(/auth/request\?[^']+)'", html)
    request_url = "https://oauth.telegram.org" + m.group(1) if m else f"https://oauth.telegram.org/auth/request?{qs}"
    m = re.search(r"ajax\('(/auth/login\?[^']+)'", html)
    login_url = "https://oauth.telegram.org" + m.group(1) if m else f"https://oauth.telegram.org/auth/login?{qs}"
    m2 = re.search(r"window\.location = '(/auth/auth\?[^']+)' \+ qtoken", html)
    quick_url = "https://oauth.telegram.org" + m2.group(1) if m2 else None

    phone = re.sub(r"[^0-9]", "", me.phone_number or "")
    if not phone:
        log("FAIL nomor HP tidak terbaca dari session")
        return False
    log("request kode ke nomor:", phone[:4] + "****" + phone[-3:])

    raw = http.post(request_url, phone_page, {"phone": phone})
    log("/auth/request ->", raw[:200])
    qtoken = raw.strip().strip('"')
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, str):
            qtoken = parsed
        elif isinstance(parsed, dict):
            qtoken = parsed.get("qtoken") or qtoken
    except Exception:
        pass
    if not qtoken or len(qtoken) < 8:
        log("FAIL qtoken tidak valid dari /auth/request")
        return False
    log("qtoken:", qtoken)
    log(">>> BUKA APLIKASI TELEGRAM, TAP CONFIRM <<<")

    # Coba MTProto langsung pakai qtoken awal
    kind, redirect = await try_mtproto_accept(app, qtoken, auth_url)
    if kind == "accepted" and redirect:
        s, final, _ = http.get(redirect)
        log(f"callback GET -> HTTP {s} ({final[:140]})")
        log("OK connect Telegram diterima (auto)")
        return True

    tried_tokens = {qtoken}
    deadline = time.time() + 45
    i = 0
    while time.time() < deadline:
        poll = http.post_json(login_url + f"&qtoken={qtoken}", phone_page)
        st = poll.get("status")
        if poll.get("qtoken"):
            qtoken = poll["qtoken"]
        if st in ("consumed", "confirmed", "refresh"):
            log(f"poll#{i}:", json.dumps(poll)[:220])
        if st == "refresh":
            fresh = poll.get("qtoken") or qtoken
            if fresh and fresh not in tried_tokens:
                tried_tokens.add(fresh)
                kind, redirect = await try_mtproto_accept(app, fresh, auth_url)
                if kind == "accepted" and redirect:
                    s, final, _ = http.get(redirect)
                    log(f"callback GET -> HTTP {s} ({final[:140]})")
                    log("OK connect Telegram diterima (auto)")
                    return True
                if kind in ("accepted", "login_token"):
                    log("MTProto diterima, lanjut poll buat quick_auth...")
        if st == "consumed":
            final_url = (quick_url or f"https://oauth.telegram.org/auth/auth?{qs}&quick_auth=1&quick_auth_token=") + str(qtoken)
            s, final, _ = http.get(final_url)
            log(f"quick_auth GET -> HTTP {s} ({final[:140]})")
            log("OK connect Telegram diterima")
            return True
        if st == "confirmed":
            s, final, _ = http.get(phone_page)
            log(f"reload phone page -> HTTP {s} ({final[:140]})")
            log("OK connect Telegram diterima (confirmed)")
            return True
        i += 1
        await asyncio.sleep(1)
    log("FAIL timeout menunggu konfirmasi")
    return False


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

    # Log semua update mentah yang masuk (riset: apakah prompt konfirmasi
    # datang sebagai update MTProto yang bisa di-accept otomatis).
    @app.on_raw_update()
    async def _log_update(client, update, users, chats):
        try:
            log("UPDATE:", type(update).__name__, str(update)[:300])
        except Exception:
            pass

    async with app:
        me = await app.get_me()
        log(f"login sebagai @{me.username or me.id}")

        # Kasus 1: link bot t.me/<bot> (dengan atau tanpa ?start=<token>)
        m = re.search(r"t\.me/([^/?#]+)(?:\?start=([^&\s]+))?", url)
        if m and "oauth" not in url:
            bot = m.group(1)
            token = urllib.parse.unquote(m.group(2)) if m.group(2) else ""
            await app.send_message(bot, f"/start {token}".strip())
            await asyncio.sleep(3)
            log(f"OK /start terkirim ke @{bot}")
            return

        # Kasus 2: oauth.telegram.org (OIDC) -> flow nomor HP
        if "oauth.telegram.org" in url:
            try:
                ok = await phone_login(app, me, url)
                if not ok:
                    log("fallback: tap link manual di HP buat konfirmasi")
            except Exception as e:
                log("FAIL phone flow:", type(e).__name__, str(e)[:300])
                log("fallback: tap link manual di HP buat konfirmasi")
            return

        log("FAIL format URL tidak dikenal, tap manual:", url[:200])


if __name__ == "__main__":
    asyncio.run(main())
