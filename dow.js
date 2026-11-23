// dow.js — Dow Protocol Points (app.dowprotocol.com/points)
// Full HTTP, no browser. Node.js + ethers.
//
// File yang dibutuhkan (di folder yang sama):
//   wallet.txt  -> 1 private key per baris
//   akun.txt    -> per akun X: 2 baris (auth_token, ct0), pisah baris kosong
//   tweet.txt (opsional)    -> 1 URL tweet per baris (urutan = urutan akun)
// Kode referral diisi di REF_CODE di bawah (nanti setelah akun pertama jalan).
//
// Pasangan wallet <-> akun X berdasarkan urutan (index sama).
//
// Cara jalan: node dow.js [all|<n>|from<n>]
//   tanpa argumen = menu interaktif (pilih akun, lalu pilih mode)

const fs = require('fs');
const readline = require('readline');
const { Wallet } = require('ethers');

const API = 'https://points-api.dowprotocol.com';
const PRIVY_API = 'https://auth.privy.io';
const PRIVY_APP_ID = 'cmc04922y00a3lb0lln560mag';
const ORIGIN = 'https://app.dowprotocol.com';
const CHAIN_ID = '56'; // BSC mainnet
const REF_CODE = ''; // <-- isi kode referral akun pertama di sini nanti, contoh: 'APXLZ'
const X_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- baca file ----------
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
function readXAccounts(file) {
  if (!fs.existsSync(file)) return [];
  const blocks = fs.readFileSync(file, 'utf8').split(/\r?\n\s*\r?\n/);
  return blocks.map((b) => {
    const lines = b.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return lines.length >= 2 ? { auth_token: lines[0], ct0: lines[1] } : null;
  }).filter(Boolean);
}

// ---------- http ----------
async function api(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

// ---------- sesi ----------
function sessionFile(addr) { return `session-${addr.toLowerCase()}.json`; }
function loadSession(addr) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(addr), 'utf8'));
    if (s.exp && Date.now() / 1000 < s.exp - 60) return s;
  } catch {}
  return null;
}
function saveSession(addr, token) {
  let exp = 0;
  try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp || 0; } catch {}
  fs.writeFileSync(sessionFile(addr), JSON.stringify({ token, exp }), { mode: 0o600 });
}

async function login(w) {
  const cached = loadSession(w.address);
  if (cached) {
    const t = await api('/api/v1/points/overview', { token: cached.token });
    if (t.status === 200) return { token: cached.token, overview: t.data };
  }
  const n = await api('/api/v1/auth/nonce', {
    method: 'POST',
    body: { wallet_address: w.address, chain_type: 'evm', chain_id: CHAIN_ID },
  });
  if (n.status !== 200) throw new Error(`nonce ${n.status}: ${JSON.stringify(n.data).slice(0, 200)}`);
  const sig = await w.signMessage(n.data.message);
  const v = await api('/api/v1/auth/verify', {
    method: 'POST',
    body: { challenge_id: n.data.challenge_id, wallet_address: w.address, signature: sig },
  });
  if (v.status !== 200 || !v.data.access_token) throw new Error(`verify ${v.status}: ${JSON.stringify(v.data).slice(0, 200)}`);
  saveSession(w.address, v.data.access_token);
  return { token: v.data.access_token };
}

// ---------- mode ----------
async function doOverview(w, token, cached) {
  const r = cached ? { status: 200, data: cached } : await api('/api/v1/points/overview', { token });
  if (r.status !== 200) { console.log(`[overview] ${r.status}`, JSON.stringify(r.data).slice(0, 200)); return null; }
  const d = r.data;
  const p = d.points || {};
  const ref = d.referral || {};
  console.log(`[points] total=${p.total_points ?? 0} task=${p.task_points ?? 0} referral=${p.referral_points ?? 0} deposit=${d.deposit_points?.total_points ?? 0}`);
  console.log(`[referral] kode=${ref.invite_code ?? '-'} invited=${ref.invited_count ?? 0} bound=${ref.has_bound_inviter ? ref.bound_invite_code : 'belum'}`);
  return d;
}

async function doQuests(w, token) {
  const r = await api('/api/v1/quests', { token });
  if (r.status !== 200) { console.log(`[quests] ${r.status}`, JSON.stringify(r.data).slice(0, 200)); return []; }
  for (const q of r.data) {
    console.log(`[quest] ${q.quest_code}: ${q.status} (+${q.reward_points})`);
  }
  return r.data;
}

async function doReferralBind(w, token, code) {
  if (!code) { console.log('[referral] skip: tidak ada kode'); return; }
  const ov = await api('/api/v1/points/overview', { token });
  if (ov.data?.referral?.has_bound_inviter) { console.log(`[referral] sudah bound: ${ov.data.referral.bound_invite_code}`); return; }
  if (ov.data?.referral?.invite_code === code) { console.log('[referral] skip: kode sendiri'); return; }
  const c = await api('/api/v1/referrals/bind/challenge', {
    method: 'POST', token, body: { invite_code: code, chain_id: CHAIN_ID },
  });
  if (c.status !== 200) { console.log(`[referral] challenge ${c.status}`, JSON.stringify(c.data).slice(0, 200)); return; }
  const sig = await w.signMessage(c.data.message);
  const b = await api('/api/v1/referrals/bind', {
    method: 'POST', token, body: { challenge_id: c.data.challenge_id, signature: sig },
  });
  console.log(`[referral] bind ${code}: ${b.status}`, b.status === 200 ? 'OK' : JSON.stringify(b.data).slice(0, 200));
}

async function doTweet(w, token, url) {
  if (!url) { console.log('[tweet] skip: tidak ada URL (isi tweet.txt)'); return; }
  const r = await api('/api/v1/quests/post_tweet/submissions', {
    method: 'POST', token, body: { tweet_url: url },
  });
  console.log(`[tweet] submit: ${r.status}`, r.status === 200 ? 'OK (nunggu review)' : JSON.stringify(r.data).slice(0, 200));
}

async function doClaim(w, token) {
  const r = await api('/api/v1/rewards', { token });
  if (r.status !== 200) { console.log(`[claim] rewards ${r.status}`, JSON.stringify(r.data).slice(0, 200)); return; }
  const d = r.data;
  console.log(`[claim] available=${d.available} claimed=${d.claimed} enabled=${d.claims_enabled} ready=${d.ready}`);
  if (!d.available || Number(d.available) <= 0) { console.log('[claim] belum ada yang bisa diklaim'); return; }
  const c = await api('/api/v1/rewards/claim/challenge', { method: 'POST', token, body: {} });
  if (c.status !== 200) { console.log(`[claim] challenge ${c.status}`, JSON.stringify(c.data).slice(0, 200)); return; }
  const sig = await w.signMessage(c.data.message);
  const a = await api('/api/v1/rewards/claim/authorize', {
    method: 'POST', token, body: { challenge_id: c.data.challenge_id, signature: sig },
  });
  console.log(`[claim] authorize: ${a.status}`, JSON.stringify(a.data).slice(0, 400));
  if (a.status === 200) console.log('[claim] authorize OK — klaim on-chain butuh gas BNB, stop di sini (perlu OK manual)');
}

// Connect X lewat Privy OAuth link pakai cookies X (best effort).
async function doConnectX(w, token, x) {
  if (!x) { console.log('[connect-x] skip: tidak ada akun X di akun.txt'); return; }
  try {
    // 1) Privy SIWE login
    const pn = await fetch(`${PRIVY_API}/api/v1/auth/nonce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'privy-app-id': PRIVY_APP_ID, Origin: ORIGIN },
      body: JSON.stringify({ address: w.address }),
    });
    const pnData = await pn.json().catch(() => ({}));
    if (!pn.ok || !pnData.nonce) throw new Error(`privy nonce ${pn.status}`);
    const issued = new Date().toISOString();
    const msg = `app.dowprotocol.com wants you to sign in with your Ethereum account:\n${w.address}\n\nBy signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.\n\nURI: ${ORIGIN}\nVersion: 1\nChain ID: ${CHAIN_ID}\nNonce: ${pnData.nonce}\nIssued At: ${issued}`;
    const sig = await w.signMessage(msg);
    const pv = await fetch(`${PRIVY_API}/api/v1/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'privy-app-id': PRIVY_APP_ID, Origin: ORIGIN },
      body: JSON.stringify({ message: msg, signature: sig, chainId: `eip155:${CHAIN_ID}` }),
    });
    const pvData = await pv.json().catch(() => ({}));
    if (!pv.ok || !pvData.token) throw new Error(`privy verify ${pv.status}: ${JSON.stringify(pvData).slice(0, 150)}`);
    const privyToken = pvData.token;

    // 2) Privy OAuth init (twitter, mode link)
    const oi = await fetch(`${PRIVY_API}/api/v1/oauth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'privy-app-id': PRIVY_APP_ID, Origin: ORIGIN, Authorization: `Bearer ${privyToken}` },
      body: JSON.stringify({ provider: 'twitter', redirect_to: `${ORIGIN}/points` }),
    });
    const oiData = await oi.json().catch(() => ({}));
    const authUrl = oiData.url || oiData.redirect_url;
    if (!oi.ok || !authUrl) throw new Error(`oauth init ${oi.status}: ${JSON.stringify(oiData).slice(0, 150)}`);

    // 3) X OAuth authorize pakai cookies
    const u = new URL(authUrl);
    const q = u.searchParams.toString();
    const xHeaders = {
      Authorization: `Bearer ${X_BEARER}`,
      'x-csrf-token': x.ct0,
      Cookie: `auth_token=${x.auth_token}; ct0=${x.ct0}`,
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
    };
    const xa = await fetch(`https://x.com/i/api/2/oauth2/authorize?${q}`, { headers: xHeaders });
    const xaData = await xa.json().catch(() => ({}));
    if (!xaData.auth_code) throw new Error(`x authorize ${xa.status}: ${JSON.stringify(xaData).slice(0, 150)}`);
    const xp = await fetch('https://x.com/i/api/2/oauth2/authorize', {
      method: 'POST',
      headers: { ...xHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval: true, code: xaData.auth_code }),
    });
    const xpData = await xp.json().catch(() => ({}));
    if (!xpData.redirect_uri) throw new Error(`x approve ${xp.status}: ${JSON.stringify(xpData).slice(0, 150)}`);

    // 4) Ikuti redirect ke Privy callback
    await fetch(xpData.redirect_uri, { redirect: 'follow' });
    console.log('[connect-x] OAuth selesai, cek status quest...');
    await sleep(1500);
    const qs = await doQuests(w, token);
    const cx = qs.find((qq) => qq.quest_code === 'connect_x');
    console.log(`[connect-x] status quest: ${cx?.status ?? '?'}`);
  } catch (e) {
    console.log(`[connect-x] gagal otomatis: ${e.message}`);
    console.log('[connect-x] konek manual aja di situs (tombol Connect X)');
  }
}

// ---------- main ----------
(async () => {
  const pks = readLines('wallet.txt');
  if (!pks.length) { console.log('wallet.txt kosong / tidak ada. Isi 1 privkey per baris.'); process.exit(1); }
  const xAccounts = readXAccounts('akun.txt');
  const tweetUrls = readLines('tweet.txt');
  let refCode = REF_CODE.trim();

  const wallets = pks.map((pk, i) => {
    try { return new Wallet(pk.startsWith('0x') ? pk : '0x' + pk); }
    catch { console.log(`wallet.txt baris ${i + 1}: privkey tidak valid, skip`); return null; }
  }).filter(Boolean);

  // --- pilih akun ---
  let idxs;
  const arg = process.argv[2];
  if (arg === 'all') idxs = wallets.map((_, i) => i);
  else if (/^\d+$/.test(arg || '')) idxs = [Number(arg) - 1];
  else if (/^from\d+$/.test(arg || '')) idxs = wallets.map((_, i) => i).filter((i) => i >= Number(arg.slice(4)) - 1);
  else {
    console.log(`Total ${wallets.length} wallet.`);
    console.log('1) 1 akun');
    console.log('2) semua');
    console.log('3) from X to end');
    const c = (await ask('Pilih (1/2/3): ')).trim();
    if (c === '2') idxs = wallets.map((_, i) => i);
    else if (c === '3') {
      const from = Number((await ask('Dari akun nomor: ')).trim()) || 1;
      idxs = wallets.map((_, i) => i).filter((i) => i >= from - 1);
    } else {
      const n = Number((await ask('Akun nomor: ')).trim()) || 1;
      idxs = [n - 1];
    }
  }
  idxs = idxs.filter((i) => i >= 0 && i < wallets.length);
  if (!idxs.length) { console.log('Tidak ada akun terpilih.'); process.exit(1); }

  // --- pilih mode ---
  console.log('Mode:');
  console.log('1) konek wallet + konek X');
  console.log('2) overview (points + referral)');
  console.log('3) quests (cek status)');
  console.log('4) referral bind');
  console.log('5) tweet submit');
  console.log('6) claim rewards (authorize)');
  console.log('7) semua (overview + quests + referral + connect X)');
  const mode = (await ask('Pilih mode (1-7): ')).trim();

  // kode referral: kalau tidak ada referral.txt, pakai kode akun pertama yang dijalankan
  let firstCode = refCode;

  for (const i of idxs) {
    const w = wallets[i];
    console.log(`\n===== Akun ${i + 1}/${wallets.length}: ${w.address} =====`);
    try {
      const { token, overview } = await login(w);
      console.log('[login] OK');
      if (mode === '1') await doConnectX(w, token, xAccounts[i]);
      if (mode === '2' || mode === '7') {
        const ov = await doOverview(w, token, overview);
        if (!firstCode && ov?.referral?.invite_code) firstCode = ov.referral.invite_code;
      }
      if (mode === '3' || mode === '7') await doQuests(w, token);
      if (mode === '4' || mode === '7') await doReferralBind(w, token, firstCode);
      if (mode === '5') await doTweet(w, token, tweetUrls[i]);
      if (mode === '6') await doClaim(w, token);
      if (mode === '7') await doConnectX(w, token, xAccounts[i]);
      if (mode === '7') await doOverview(w, token, null);
    } catch (e) {
      console.log(`[error] ${e.message}`);
    }
    await sleep(800);
  }
  rl.close();
  console.log('\nSelesai.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
