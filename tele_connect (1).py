#!/usr/bin/env python3
# tele_connect.py — auto-connect Telegram untuk Dow Points pakai session string Pyrogram.
# Dipanggil oleh dow.js: python3 tele_connect.py <session_string> <authorization_url>
# api_id/api_hash dibaca dari file tele_api.txt (baris 1 = api_id, baris 2 = api_hash)
# di folder yang sama, atau dari env API_ID / API_HASH.
# Output: baris terakhir "OK ..." kalau berhasil, "FAIL ..." kalau gagal.

import sys, os, re, asyncio, urllib.request, urllib.parse, http.cookiejar, time

def log(*a):
    print("[tele-py]", *a, flush=True)

def load_api():
    api_id = os.environ.get("API_ID")
    api_hash = os.environ.get("API_HASH")
    if not api_id or not api_hash:
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tele_api.txt")
        if os.path.exists(p):
            vals = []
            for l in open(p, encoding="utf-8"):
                l = l.strip()
                if not l:
                    continue
                # terima format polos (nilai saja) atau berlabel (api_id: xxx)
                l = re.sub(r"^(api_id|api_hash)\s*[:=]\s*", "", l, flags=re.I)
                vals.append(l.strip())
            if len(vals) >= 2:
                api_id, api_hash = vals[0], vals[1]
    if not api_id or not api_hash:
        log("FAIL api_id/api_hash tidak ada (isi tele_api.txt atau env API_ID/API_HASH)")
        sys.exit(2)
    return int(api_id), api_hash

async def read_code(app, timeout=60):
    # Kode login Telegram dikirim sebagai pesan dari akun layanan Telegram (777000).
    deadline = time.time() + timeout
    seen = set()
    while time.time() < deadline:
        async for msg in app.get_chat_history(777000, limit=5):
            if msg.id in seen:
                continue
            seen.add(msg.id)
            text = msg.text or ""
            m = re.search(r"\b(\d{5,6})\b", text)
            if m:
                return m.group(1)
        await asyncio.sleep(2)
    return None

def http_opener():
    cj = http.cookiejar.CookieJar()
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

def widget_flow(app, me, url):
    # Alur Telegram Login Widget (oauth.telegram.org).
    qs = urllib.parse.urlparse(url)
    params = urllib.parse.parse_qs(qs.query)
    bot_id = params.get("bot_id", [""])[0]
    origin = params.get("origin", [""])[0]
    return_to = params.get("return_to", [""])[0]
    if not bot_id:
        log("FAIL bot_id tidak ketemu di URL widget")
        return False
    phone = "+" + re.sub(r"\D", "", me.phone_number or "")
    if len(phone) < 5:
        log("FAIL nomor HP akun Telegram tidak terbaca dari session")
        return False
    base_q = urllib.parse.urlencode({"bot_id": bot_id, "origin": origin, "return_to": return_to})
    opener = http_opener()
    headers = {"User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36"}
    # 1) buka halaman auth (ambil cookie)
    try:
        opener.open(urllib.request.Request(url, headers=headers), timeout=30).read()
    except Exception as e:
        log("WARN buka halaman auth:", e)
    # 2) minta kode
    data = urllib.parse.urlencode({"phone": phone}).encode()
    req = urllib.request.Request(f"https://oauth.telegram.org/auth/request?{base_q}", data=data, headers=headers)
    try:
        opener.open(req, timeout=30).read()
    except Exception as e:
        log("FAIL minta kode:", e)
        return False
    log("kode diminta, menunggu pesan Telegram...")
    return ("NEED_CODE", (opener, headers, base_q, phone, return_to))

async def main():
    if len(sys.argv) < 3:
        log("FAIL pemakaian: tele_connect.py <session_string> <authorization_url>")
        sys.exit(2)
    session_string, url = sys.argv[1], sys.argv[2]
    log("URL:", url[:300])
    api_id, api_hash = load_api()
    from pyrogram import Client
    app = Client("dow_tele", api_id=api_id, api_hash=api_hash, session_string=session_string, in_memory=True)
    await app.start()
    try:
        me = await app.get_me()
        log("login sebagai @" + (me.username or str(me.id)))
        # Kasus 1: link bot t.me/<bot> (dengan atau tanpa ?start=<token>)
        m = re.search(r"t\.me/([^/?#]+)(?:\?start=([^&\s]+))?", url)
        if m:
            bot = m.group(1)
            token = urllib.parse.unquote(m.group(2)) if m.group(2) else ""
            await app.send_message(bot, f"/start {token}".strip())
            await asyncio.sleep(3)
            log(f"OK /start terkirim ke @{bot}")
            return
        # Kasus 2: widget oauth.telegram.org
        if "oauth.telegram.org" in url:
            res = widget_flow(app, me, url)
            if not res:
                sys.exit(1)
            _, (opener, headers, base_q, phone, return_to) = res
            code = await read_code(app)
            if not code:
                log("FAIL kode login tidak datang dalam 60 detik")
                sys.exit(1)
            log("kode diterima, submit...")
            data = urllib.parse.urlencode({"phone": phone, "password": code}).encode()
            req = urllib.request.Request(f"https://oauth.telegram.org/auth/login?{base_q}", data=data, headers=headers)
            try:
                resp = opener.open(req, timeout=30)
                final = resp.geturl()
                resp.read()
            except urllib.error.HTTPError as e:
                final = e.headers.get("Location", "") if e.headers else ""
                log("login HTTP", e.code, "->", final[:120])
            if return_to and final.startswith(return_to.split("?")[0]):
                log("OK widget login berhasil, redirect ke Dow")
            else:
                log("WARN redirect akhir:", final[:160])
                log("OK widget login terkirim (cek status quest di dow.js)")
            return
        log("FAIL format URL tidak dikenal:", url[:160])
        sys.exit(1)
    finally:
        await app.stop()

if __name__ == "__main__":
    asyncio.run(main())
