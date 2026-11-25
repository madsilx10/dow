#!/usr/bin/env python3
"""Helper auto-confirm connect Telegram (Dow Protocol) pakai Pyrogram.

Dipanggil dow.js:  python3 tele_connect.py <session_string> <authorization_url>

Format authorization_url Dow: oauth.telegram.org/auth?... (OIDC).
Jalur otomatis (Seamless Telegram Login):
  1. GET halaman auth (sesi/cookie).
  2. Poll POST /auth/login -> ambil deep link (result.url) + qtoken.
  3. Pyrogram messages.requestUrlAuth(deep_link).
  4. Match code bila diminta (checkUrlAuthMatchCode / dari poll).
  5. messages.acceptUrlAuth(deep_link) -> GET redirect URL (callback Dow).
     Atau poll sampai 'consumed' -> GET /auth?...&quick_auth_token=<qtoken>.

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

    def post_json(self, url, referer):
        req = urllib.request.Request(
            url,
            data=b"",
            method="POST",
            headers={
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/x-www-form-urlencoded",
                "X-Requested-With": "XMLHttpRequest",
                "Referer": referer,
            },
        )
        with self.opener.open(req, timeout=30) as r:
            body = r.read().decode("utf8", "replace")
        try:
            return json.loads(body)
        except Exception:
            return {"_raw": body[:300]}


def build_qs(auth_url):
    """Query string untuk /auth/login, meniru ajax di halaman oauth."""
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


async def seamless_login(app, auth_url):
    from pyrogram.raw import functions

    http = Http()
    qs = build_qs(auth_url)
    login_url = f"https://oauth.telegram.org/auth/login?{qs}"
    quick_url = None

    status, _, _ = http.get(auth_url)
    log("GET auth page ->", status)
    # Halaman QR (/auth/auth?...&force_qr=1) memuat deep link langsung di HTML.
    qr_page_url = f"https://oauth.telegram.org/auth/auth?{qs}&force_qr=1"
    status, _, body = http.get(qr_page_url)
    log("GET QR page ->", status)
    html = body.decode("utf8", "replace")
    m = re.search(r"ajax\('(/auth/login\?[^']+)'", html)
    if m:
        login_url = "https://oauth.telegram.org" + m.group(1)
        log("login URL dari halaman QR OK")
    m2 = re.search(r"window\.location = '(/auth\?[^']+)' \+ qtoken", html)
    if m2:
        quick_url = "https://oauth.telegram.org" + m2.group(1)
    deep_link = None
    md = re.search(r"setQrLink\('(https://t\.me/oauth\?startapp=[^']+)'\)", html)
    if md:
        deep_link = md.group(1)
    if not deep_link:
        md = re.search(r"(tg://resolve\?domain=oauth&startapp=[^\"'& ]+)", html)
        if md:
            deep_link = md.group(1)
    if not deep_link:
        md = re.search(r"(https://t\.me/oauth\?startapp=[^\"'& ]+)", html)
        if md:
            deep_link = md.group(1)
    if deep_link:
        log("deep_link dari HTML:", deep_link[:200])

    qtoken, poll = None, {}
    if not deep_link:
        for i in range(15):
            poll = http.post_json(login_url + (f"&qtoken={qtoken}" if qtoken else ""), qr_page_url)
            log(f"poll#{i}:", json.dumps(poll)[:300])
            if poll.get("qtoken"):
                qtoken = poll["qtoken"]
            deep_link = poll.get("url") or poll.get("qr_url") or deep_link
            if deep_link:
                break
            await asyncio.sleep(1)
    if not deep_link:
        log("FAIL deep link tidak ketemu")
        return False
    log("deep_link:", deep_link[:200])
    # Coba semua bentuk deep link sampai requestUrlAuth menerima salah satunya.
    mtok = re.search(r"(?:startapp=|token=)([^&\s]+)", deep_link)
    token = mtok.group(1) if mtok else None
    forms = []
    if token:
        forms = [
            f"https://t.me/oauth?startapp={token}",
            f"tg://oauth?token={token}",
            f"tg://resolve?domain=oauth&startapp={token}",
        ]
    if deep_link not in forms:
        forms.append(deep_link)

    res = None
    for form in forms:
        try:
            r = await app.invoke(functions.messages.RequestUrlAuth(url=form))
            log("requestUrlAuth:", form[:80], "->", type(r).__name__)
            if type(r).__name__ != "UrlAuthResultDefault":
                res = r
                deep_link = form
                break
        except Exception as e:
            log("requestUrlAuth gagal:", form[:80], "->", str(e)[:120])
    if res is None:
        log("FAIL semua bentuk deep link ditolak/Default")
        return False
    if type(res).__name__ == "UrlAuthResultAccepted":
        redirect = getattr(res, "url", None)
        if redirect:
            s, final, _ = http.get(redirect)
            log(f"callback GET -> HTTP {s} ({final[:120]})")
        log("OK sudah accepted")
        return True

    match_codes = getattr(res, "match_codes", None)
    match_first = bool(getattr(res, "match_codes_first", False))
    log("match_codes:", match_codes, "| match_codes_first:", match_first)

    match_code = poll.get("match_code")
    if match_codes and not match_code:
        if match_first:
            for code in match_codes:
                try:
                    ok = await app.invoke(
                        functions.messages.CheckUrlAuthMatchCode(url=deep_link, match_code=code)
                    )
                    log("checkMatchCode", repr(code), "->", ok)
                    if ok:
                        match_code = code
                        break
                except Exception as e:
                    log("checkMatchCode error:", e)
                    break
        if not match_code:
            match_code = match_codes[0]
            log("match_code fallback (kandidat pertama):", repr(match_code))

    kwargs = {"url": deep_link, "write_allowed": True}
    if match_code is not None:
        kwargs["match_code"] = match_code
    acc = await app.invoke(functions.messages.AcceptUrlAuth(**kwargs))
    log("acceptUrlAuth:", type(acc).__name__)
    redirect = getattr(acc, "url", None)
    if redirect:
        s, final, _ = http.get(redirect)
        log(f"callback GET -> HTTP {s} ({final[:120]})")
        log("OK seamless login diterima")
        return True

    # Tanpa redirect: poll sampai consumed, lalu buka /auth?quick_auth_token=
    for i in range(10):
        poll = http.post_json(login_url + (f"&qtoken={qtoken}" if qtoken else ""), qr_page_url)
        log(f"post-poll#{i}:", json.dumps(poll)[:200])
        if poll.get("qtoken"):
            qtoken = poll["qtoken"]
        if poll.get("status") == "consumed":
            final_url = (quick_url or f"https://oauth.telegram.org/auth?{qs}&quick_auth_token=") + str(qtoken)
            s, final, _ = http.get(final_url)
            log(f"quick_auth GET -> HTTP {s} ({final[:120]})")
            log("OK seamless login diterima (quick_auth)")
            return True
        await asyncio.sleep(1)
    log("FAIL tidak consumed setelah accept")
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

        # Kasus 2: oauth.telegram.org (OIDC) -> Seamless Login via deep link
        if "oauth.telegram.org" in url:
            try:
                ok = await seamless_login(app, url)
                if not ok:
                    log("fallback: tap link manual di HP buat konfirmasi")
            except Exception as e:
                log("FAIL seamless:", type(e).__name__, str(e)[:300])
                log("fallback: tap link manual di HP buat konfirmasi")
            return

        log("FAIL format URL tidak dikenal, tap manual:", url[:200])


if __name__ == "__main__":
    asyncio.run(main())
