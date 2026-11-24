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
// Mode:
//   1) Quests — connect X, tweet, referral bind, claim (alurnya yang lama)
//   2) Quiz & Draw — quiz otomatis (tebak, belajar jawaban bener, ulang) + XP/draw/tiket
//   3) Daily check-in — check-in harian XP (1 tx on-chain BSC, gas BNB saja;
//      kirim langsung tanpa konfirmasi, per instruksi Rime 2026-11-24)

const fs = require('fs');
const readline = require('readline');
const { Wallet, JsonRpcProvider, Contract, formatEther } = require('ethers');

const API = 'https://points-api.dowprotocol.com';
const ORIGIN = 'https://app.dowprotocol.com';
const CHAIN_ID = '56'; // BSC mainnet
const REF_CODE = 'STN7E'; // kode referral akun pertama Rime
// Template tweet per akun: {code} diganti kode invite akun itu sendiri.
const TWEET_TEMPLATE = 'Just joined DOW Protocol — on-chain RWA financing on BSC. Earning points for quests, referrals and deposits. Join me: https://app.dowprotocol.com/points?invite_code={code} @dowprotocol';
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
async function api(path, { method = 'GET', token, body, headers } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
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
  // Referral baru kebuka setelah post tweet akun ini approved.
  const qs = await api('/api/v1/quests', { token });
  const tq = (qs.data || []).find((q) => q.quest_code === 'post_tweet');
  if (tq && tq.status !== 'completed') { console.log(`[referral] locked: post belum approved (status: ${tq.status})`); return; }
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

function xHeaders(x) {
  return {
    Authorization: `Bearer ${X_BEARER}`,
    'x-csrf-token': x.ct0,
    'x-twitter-client-language': 'en',
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    Cookie: `auth_token=${x.auth_token}; ct0=${x.ct0}`,
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  };
}

// ---------- x-client-transaction-id (port dari twikit) ----------
const crypto = require('crypto');
function floatToHex(x) {
  const result = [];
  let quotient = Math.trunc(x);
  let fraction = x - quotient;
  while (quotient > 0) {
    quotient = Math.trunc(x / 16);
    const remainder = Math.trunc(x - quotient * 16);
    result.unshift(remainder > 9 ? String.fromCharCode(remainder + 55) : String(remainder));
    x = quotient;
  }
  if (fraction === 0) return result.join('');
  result.push('.');
  while (fraction > 0) {
    fraction *= 16;
    const integer = Math.trunc(fraction);
    fraction -= integer;
    result.push(integer > 9 ? String.fromCharCode(integer + 55) : String(integer));
  }
  return result.join('');
}
const txIsOdd = (n) => (n % 2 ? -1.0 : 0.0);
const txSolve = (value, min, max, rounding) => {
  const r = (value * (max - min)) / 255 + min;
  return rounding ? Math.floor(r) : Math.round(r * 100) / 100;
};
const txInterpolate = (from, to, f) => from.map((v, i) => v * (1 - f) + to[i] * f);
const txRotMatrix = (deg) => {
  const rad = (deg * Math.PI) / 180;
  return [Math.cos(rad), -Math.sin(rad), Math.sin(rad), Math.cos(rad)];
};
class TxCubic {
  constructor(curves) { this.curves = curves; }
  static calculate(a, b, m) { return 3 * a * (1 - m) * (1 - m) * m + 3 * b * (1 - m) * m * m + m * m * m; }
  getValue(time) {
    let startGradient = 0, endGradient = 0, mid = 0;
    const c = this.curves;
    if (time <= 0) {
      if (c[0] > 0) startGradient = c[1] / c[0];
      else if (c[1] === 0 && c[2] > 0) startGradient = c[3] / c[2];
      return startGradient * time;
    }
    if (time >= 1) {
      if (c[2] < 1) endGradient = (c[3] - 1) / (c[2] - 1);
      else if (c[2] === 1 && c[0] < 1) endGradient = (c[1] - 1) / (c[0] - 1);
      return 1 + endGradient * (time - 1);
    }
    let s = 0, e = 1.0;
    while (s < e) {
      mid = (s + e) / 2;
      const xEst = TxCubic.calculate(c[0], c[2], mid);
      if (Math.abs(time - xEst) < 0.00001) return TxCubic.calculate(c[1], c[3], mid);
      if (xEst < time) s = mid; else e = mid;
    }
    return TxCubic.calculate(c[1], c[3], mid);
  }
}
function txAnimate(frames, targetTime) {
  const fromColor = [...frames.slice(0, 3), 1].map(Number);
  const toColor = [...frames.slice(3, 6), 1].map(Number);
  const toRot = [txSolve(Number(frames[6]), 60.0, 360.0, true)];
  const curves = frames.slice(7).map((v, i) => txSolve(Number(v), txIsOdd(i), 1.0, false));
  const val = new TxCubic(curves).getValue(targetTime);
  const color = txInterpolate(fromColor, toColor, val).map((v) => (v > 0 ? v : 0));
  const rotation = txInterpolate([0.0], toRot, val);
  const matrix = txRotMatrix(rotation[0]);
  const strArr = color.slice(0, -1).map((v) => Math.round(v).toString(16));
  for (const value of matrix) {
    let rounded = Math.round(value * 100) / 100;
    if (rounded < 0) rounded = -rounded;
    const hex = floatToHex(rounded);
    strArr.push(hex.startsWith('.') ? `0${hex}`.toLowerCase() : hex ? hex : '0');
  }
  strArr.push('0', '0');
  return strArr.join('').replace(/[.-]/g, '');
}
const txCache = new Map();
const FALLBACK_INDICES = [36, 7, 29, 36]; // dari ondemand.s b7491b1b81e1441b (2026-11-24); bisa berubah kalau X deploy ulang

async function fetchHomeUA(x, ua) {
  const headers = { Cookie: `auth_token=${x.auth_token}; ct0=${x.ct0}`, 'User-Agent': ua };
  let home = await (await fetch('https://x.com/', { headers, redirect: 'follow' })).text();
  const formMatch = home.match(/<form[^>]*action="(https:\/\/x\.com\/x\/migrate)"[^>]*>([\s\S]*?)<\/form>/);
  if (formMatch) {
    const params = new URLSearchParams();
    for (const inp of formMatch[2].matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) params.set(inp[1], inp[2]);
    home = await (await fetch(`${formMatch[1]}/?mx=2`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(), redirect: 'follow',
    })).text();
  }
  return { home, headers };
}

async function fetchHome(x) {
  return fetchHomeUA(x, 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36');
}

function findOndemandHash(home) {
  const odOld = home.match(/['"]ondemand\.s['"]:\s*['"](\w*)['"]/);
  if (odOld) return odOld[1];
  const cid = home.match(/(\d+):["']ondemand\.s["']/);
  if (cid) {
    const hm = home.match(new RegExp(`${cid[1]}:["']([a-z0-9]+)["']`, 'g'));
    const hashes = (hm || []).map((s) => s.split(/["']/)[1]).filter((h) => h !== 'ondemand.s');
    if (hashes[0]) return hashes[0];
  }
  return null;
}

async function initTx(x) {
  if (txCache.has(x.auth_token)) return txCache.get(x.auth_token);
  let { home, headers } = await fetchHome(x);
  let odHash = findOndemandHash(home);
  if (!odHash) {
    // Cadangan 1: cari di bundle main.js
    const mainMatch = home.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-z0-9]+\.js/);
    if (mainMatch) {
      const mainText = await (await fetch(mainMatch[0], { headers })).text();
      odHash = findOndemandHash(mainText);
    }
  }
  if (!odHash) {
    // Cadangan 2: X kadang ngasih halaman lite tanpa chunk map. Coba UA desktop.
    const desk = await fetchHomeUA(x, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36');
    odHash = findOndemandHash(desk.home);
    if (odHash) { home = desk.home; }
  }
  let indices;
  if (odHash) {
    const odText = await (await fetch(`https://abs.twimg.com/responsive-web/client-web/ondemand.s.${odHash}a.js`, { headers })).text();
    indices = [...odText.matchAll(/\(\w\[(\d{1,2})\],\s*16\)/g)].map((m) => Number(m[1]));
    if (!indices.length) indices = FALLBACK_INDICES;
  } else {
    indices = FALLBACK_INDICES;
  }
  const keyMatch = home.match(/name="twitter-site-verification" content="([^"]+)"/);
  if (!keyMatch) throw new Error('verification key tidak ketemu');
  const keyBytes = [...Buffer.from(keyMatch[1], 'base64')];
  const frameBlocks = [...home.matchAll(/<svg[^>]*id="loading-x-anim-\d+"[^>]*>([\s\S]*?)<\/svg>/g)].map((m) => m[1]);
  if (!frameBlocks.length) throw new Error('frames tidak ketemu');
  const block = frameBlocks[keyBytes[5] % 4];
  const ds = [...block.matchAll(/\bd="([^"]+)"/g)].map((m) => m[1]);
  const d = (ds[1] || ds[0] || '').slice(9);
  const arr = d.split('C').map((item) => item.replace(/[^\d]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number));
  const rowIndex = keyBytes[indices[0]] % 16;
  const frameTime = indices.slice(1).reduce((a, i) => a * (keyBytes[i] % 16), 1);
  const animationKey = txAnimate(arr[rowIndex], frameTime / 4096);
  const tx = { keyBytes, animationKey };
  txCache.set(x.auth_token, tx);
  return tx;
}
function genTxId(tx, method, path) {
  const timeNow = Math.floor((Date.now() - 1682924400000) / 1000);
  const timeBytes = [0, 1, 2, 3].map((i) => (timeNow >> (i * 8)) & 0xff);
  const hash = crypto.createHash('sha256').update(`${method}!${path}!${timeNow}obfiowerehiring${tx.animationKey}`).digest();
  const bytesArr = [...tx.keyBytes, ...timeBytes, ...hash.slice(0, 16), 3];
  const rand = crypto.randomInt(0, 256);
  return Buffer.from([rand, ...bytesArr.map((b) => b ^ rand)]).toString('base64').replace(/=+$/, '');
}

// Auto-post tweet pakai cookies X. Return URL tweet atau null kalau gagal.
async function autoPost(x, inviteCode) {
  const h = xHeaders(x);
  const text = TWEET_TEMPLATE.replace('{code}', inviteCode || '');
  let username = 'i';
  try {
    const vc = await fetch('https://x.com/i/api/1.1/account/verify_credentials.json', { headers: h });
    const vcd = await vc.json().catch(() => ({}));
    if (vcd.screen_name) username = vcd.screen_name;
  } catch {}
  const body = {
    variables: {
      tweet_text: text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    },
    features: {
      premium_content_api_read_enabled: false,
      communities_web_enable_tweet_community_results_fetch: true,
      c9s_tweet_anatomy_moderator_badge_enabled: true,
      responsive_web_grok_analyze_button_fetch_trends_enabled: false,
      responsive_web_grok_analyze_post_followups_enabled: false,
      responsive_web_jetfuel_frame: false,
      responsive_web_grok_share_attachment_enabled: false,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: true,
      tweet_awards_web_tipping_enabled: false,
      responsive_web_grok_show_grok_translated_post: false,
      responsive_web_grok_analysis_button_from_backend: true,
      creator_subscriptions_quote_tweet_preview_enabled: false,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      profile_label_improvements_pcf_label_in_post_enabled: true,
      rweb_tipjar_consumption_enabled: true,
      verified_phone_label_enabled: false,
      articles_preview_enabled: true,
      rweb_video_timestamps_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      responsive_web_grok_image_annotation_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_enhance_cards_enabled: false,
    },
    queryId: 'SoVnbfCycZ7fERGCwpZkYA',
  };
  const tx = await initTx(x);
  const txId = genTxId(tx, 'POST', '/i/api/graphql/SoVnbfCycZ7fERGCwpZkYA/CreateTweet');
  const r = await fetch('https://x.com/i/api/graphql/SoVnbfCycZ7fERGCwpZkYA/CreateTweet', {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json', 'x-client-transaction-id': txId, Origin: 'https://x.com', Referer: 'https://x.com/compose/post' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  const res = d?.data?.create_tweet?.tweet_results?.result;
  const id = res?.rest_id;
  if (!id) throw new Error(`CreateTweet ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  const sn = res?.core?.user_results?.result?.legacy?.screen_name || res?.core?.user_results?.result?.core?.screen_name;
  if (sn) username = sn;
  return `https://x.com/${username}/status/${id}`;
}

async function doTweet(w, token, url, x, inviteCode) {
  const qs = await api('/api/v1/quests', { token });
  const tq = (qs.data || []).find((q) => q.quest_code === 'post_tweet');
  if (tq?.status === 'completed') { console.log('[tweet] sudah completed'); return; }
  if (tq?.status === 'under_review' || tq?.has_approved_submission || tq?.latest_submission) { console.log(`[tweet] sudah submit (status: ${tq.status})`); return; }
  // Catatan lokal: kalau run sebelumnya sudah post tapi submit gagal/error,
  // pakai URL yang sama, jangan post ulang.
  const postedFile = `posted-${w.address.toLowerCase()}.json`;
  if (!url) {
    try {
      const rec = JSON.parse(fs.readFileSync(postedFile, 'utf8'));
      if (rec.url) { url = rec.url; console.log(`[tweet] pakai post sebelumnya: ${url}`); }
    } catch {}
  }
  if (!url) {
    if (!x) { console.log('[tweet] skip: tidak ada URL dan tidak ada akun X'); return; }
    try {
      url = await autoPost(x, inviteCode);
      fs.writeFileSync(postedFile, JSON.stringify({ url, at: new Date().toISOString() }), { mode: 0o600 });
      console.log(`[tweet] auto-post OK: ${url}`);
    } catch (e) {
      console.log(`[tweet] auto-post gagal: ${e.message}`);
      console.log('[tweet] post manual, URL-nya taruh di tweet.txt');
      return;
    }
  }
  // URL format /i/status/ ditolak server (username harus cocok dengan akun X terkonek).
  if (url && url.includes('/i/status/') && x) {
    const id = url.split('/status/')[1];
    let username = null;
    try {
      const page = await (await fetch(`https://x.com/i/status/${id}`, { headers: xHeaders(x) })).text();
      const near = page.match(new RegExp(`"rest_id":"${id}"[\\s\\S]{0,3000}?"screen_name":"([^"]+)"`));
      const any = page.match(/"screen_name":"([^"]+)"/);
      username = (near && near[1]) || (any && any[1]) || null;
    } catch {}
    if (!username) {
      try {
        const oe = await (await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}`)).json();
        const m = (oe.author_url || '').match(/x\.com\/([^/]+)/);
        if (m) username = m[1];
      } catch {}
    }
    if (username) {
      url = url.replace('/i/status/', `/${username}/status/`);
      fs.writeFileSync(postedFile, JSON.stringify({ url, at: new Date().toISOString() }), { mode: 0o600 });
      console.log(`[tweet] URL dibenerin: ${url}`);
    } else {
      console.log('[tweet] username tidak ketemu, URL tetap /i/');
    }
  }
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

// Connect X lewat OAuth points-api pakai cookies X (akun.txt).
async function doConnectX(w, token, x) {
  if (!x) { console.log('[connect-x] skip: tidak ada akun X di akun.txt'); return; }
  const qs0 = await api('/api/v1/quests', { token });
  const cx0 = (qs0.data || []).find((q) => q.quest_code === 'connect_x');
  if (cx0?.status === 'completed') { console.log('[connect-x] sudah konek'); return; }
  try {
    const c = await api('/api/v1/social/x/connect', { method: 'POST', token });
    if (c.status !== 200 || !c.data?.authorization_url) throw new Error(`connect ${c.status}: ${JSON.stringify(c.data).slice(0, 150)}`);
    const q = new URL(c.data.authorization_url).searchParams.toString();
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
    await fetch(xpData.redirect_uri, { redirect: 'follow' });
    await sleep(1500);
    const qs = await api('/api/v1/quests', { token });
    const cx = (qs.data || []).find((qq) => qq.quest_code === 'connect_x');
    console.log(`[connect-x] status quest: ${cx?.status ?? '?'}`);
  } catch (e) {
    console.log(`[connect-x] gagal: ${e.message}`);
  }
}

// ---------- mode 2: quiz & draw/XP ----------
// Quiz: 5 soal per attempt, lolos minimal 3/5, cooldown 24 jam per proyek
// setelah attempt selesai (retry hari yang sama = 409 project_cooldown).
// Kunci jawaban dipelajari dari server (jawaban bener diungkap setelah jawab)
// dan ditanam di bawah — untuk proyek lain, skrip tebak dulu sambil belajar,
// jawaban yang dipelajari di-print di akhir biar bisa ditanam berikutnya.
const QUIZ_KEYS = {
  'united-stables': {
    'Which network is United Stables built on?': 'BNB Chain',
    'Who decides on upgrades in United Stables?': 'Community DAO',
    'United Stables targets inclusion in:': 'DeFi money markets',
    'If the collateral ratio drops, United Stables may:': 'Trigger liquidations',
    'Which is used to monitor stablecoin price?': 'Oracles',
    'The central goal of United Stables is to:': 'Create a decentralized stablecoin ecosystem',
    'United Stables protocol aims for:': 'Stable asset value',
    'The United Stables token is usually:': 'Algorithmic stablecoin',
  },
  'venus': {
    'On which chain does Venus Protocol operate?': 'BNB Chain',
    'How are interest rates determined on Venus Protocol?': 'Algorithmic market dynamics',
    'The Venus Protocol stablecoin is called:': 'VAI',
    'Which of the following is a function NOT offered by Venus Protocol?': 'Synthetic stock trading',
  },
};

function parseSSE(text) {
  const events = [];
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    const ev = {};
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) ev.event = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5).trim()); } catch { ev.data = line.slice(5).trim(); } }
    }
    if (ev.data !== undefined) events.push(ev);
  }
  return events;
}

async function doQuiz(w, token) {
  const lp = await api('/api/v1/points/quiz/projects', { token });
  const projects = lp.data?.projects || (Array.isArray(lp.data) ? lp.data : []);
  if (!Array.isArray(projects) || !projects.length) { console.log(`[quiz] projects ${lp.status}`, JSON.stringify(lp.data).slice(0, 200)); return; }
  console.log('[quiz] proyek:');
  projects.forEach((p, i) => console.log(`  ${i + 1}) ${p.key || p.projectKey || p.slug} (baseXp ${p.baseXp ?? 50} + bonus ${p.bonusXp ?? 50})`));
  const sel = Number((await ask('Quiz proyek nomor (default: united-stables): ')).trim());
  const proj = (sel ? projects[sel - 1] : null)
    || projects.find((p) => (p.key || p.projectKey || p.slug) === 'united-stables')
    || projects[0];
  const key = proj.key || proj.projectKey || proj.slug;
  const baked = QUIZ_KEYS[key] || {};
  console.log(`[quiz] proyek: ${key}${Object.keys(baked).length ? ' (kunci jawaban ada)' : ' (belum ada kunci — tebak + belajar)'}`);

  // POST attempts balasannya SSE, bukan JSON.
  console.log('[quiz] membuat attempt...');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let raw;
  try {
    raw = await fetch(API + `/api/v1/points/quiz/${key}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
  } catch (e) {
    console.log(`[quiz] request attempt gagal/timeout (${e.name}) — coba lagi`);
    return;
  } finally { clearTimeout(timer); }
  const rawText = await raw.text();
  let attemptId = null;
  if (raw.status === 200) {
    const evs = parseSSE(rawText);
    attemptId = evs.find((e) => e.data?.attemptId)?.data?.attemptId || null;
  } else {
    try { const d = JSON.parse(rawText); attemptId = d.attemptId || null; if (d.retryAt) console.log(`[quiz] cooldown sampai ${d.retryAt}`); } catch {}
    if (!attemptId) { console.log(`[quiz] attempt ${raw.status}`, rawText.slice(0, 200)); return; }
    console.log('[quiz] lanjut attempt yang masih aktif');
  }
  if (!attemptId) { console.log('[quiz] attemptId tidak ketemu'); return; }

  const learned = {};
  let finalScore = null;
  for (let guard = 0; guard < 10; guard++) {
    const g = await api(`/api/v1/points/quiz/attempts/${attemptId}`, { token });
    const d = g.data || {};
    if (d.status !== 'active' || !d.currentQuestion) {
      finalScore = d.score || null;
      console.log(`[quiz] attempt selesai: status=${d.status}${finalScore ? ` skor=${finalScore.correct ?? '?'}/${finalScore.total ?? '?'} (lolos min ${finalScore.required ?? 3})` : ''}`);
      break;
    }
    // Pelajari jawaban bener dari jawaban sebelumnya (GET answers[]).
    for (const a of d.answers || []) {
      if (a.question && a.correctOption?.text) learned[a.question] = a.correctOption.text;
      if (a.prompt && a.correctOption?.text) learned[a.prompt] = a.correctOption.text;
    }
    const q = d.currentQuestion;
    // Dump mentah GET pertama (buat cek apakah field brief sudah berisi
    // jawaban sebelum jawab) — kirim file attempt-<proyek>-dump.json ke Muse.
    if (guard === 0) { try { fs.writeFileSync(`attempt-${key}-dump.json`, JSON.stringify(d, null, 1)); } catch {} }
    const prompt = q.prompt || q.text || q.question || '';
    const opts = q.options || q.choices || [];
    const want = baked[prompt] || learned[prompt];
    let opt = opts.find((o) => (o.text || o.label) === want) || opts.find((o) => o.id === want);
    if (!opt && opts.length) opt = opts[0];
    if (!opt) { console.log(`[quiz] soal ${q.index}: tidak ada opsi`); break; }
    const optId = opt.id ?? opt.optionId ?? opt.value ?? opt.key;
    await api(`/api/v1/points/quiz/attempts/${attemptId}/answers`, {
      method: 'POST', token, body: { questionIndex: q.index, optionId: optId },
    });
  }
  const passed = finalScore ? (finalScore.passed ?? (finalScore.correct ?? 0) >= (finalScore.required ?? 3)) : false;
  if (!passed) { console.log('[quiz] tidak lolos (min 3/5) — tidak bisa klaim'); }
  else {
    const delay = (await api(`/api/v1/points/quiz/attempts/${attemptId}`, { token })).data?.claimDelaySeconds ?? 20;
    console.log(`[quiz] lolos, tunggu ${delay} detik sebelum klaim...`);
    await sleep(delay * 1000 + 1000);
    const cl = await api(`/api/v1/points/quiz/attempts/${attemptId}/claim`, {
      method: 'POST', token, body: { briefReadToEnd: true },
    });
    console.log(`[quiz] claim: ${cl.status}`, cl.status === 200 ? JSON.stringify(cl.data).slice(0, 200) : 'kemungkinan kena Turnstile — klaim manual di web. ' + JSON.stringify(cl.data).slice(0, 200));
  }
  const fresh = Object.keys(learned).filter((t) => !baked[t]);
  if (fresh.length) {
    console.log('[quiz] kunci baru dipelajari (kirim ke Muse biar ditanam):');
    for (const t of fresh) console.log(`  Q: ${t} => ${learned[t]}`);
  }
}

async function doDraw(w, token) {
  const e = await api('/api/v1/points/experience', { token });
  if (e.status !== 200) { console.log(`[xp] experience ${e.status}`, JSON.stringify(e.data).slice(0, 200)); return; }
  const d = e.data;
  console.log(`[xp] availableXp=${d.availableXp ?? 0} lifetimeXp=${d.lifetimeXp ?? 0} tiket=${d.tickets ?? 0} dUSC=${d.duscBalance ?? 0}`);
  if (d.checkIn) console.log(`[xp] check-in hari ke-${d.checkIn.cycleDay ?? '?'} streak=${d.checkIn.streak ?? 0} claimedToday=${d.checkIn.claimedToday} (check-in harian butuh tx on-chain — belum di mode ini)`);
  const dr = await api('/api/v1/points/draw', { token });
  if (dr.status === 200) console.log(`[draw] status: ${JSON.stringify(dr.data?.drawStatus ?? dr.data).slice(0, 300)}`);
  const ex = Number((await ask('Tukar XP ke tiket? (100 XP/tiket, 0 = skip): ')).trim()) || 0;
  if (ex > 0) {
    const r = await api('/api/v1/points/experience/exchange-tickets', {
      method: 'POST', token, body: { count: ex },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    console.log(`[xp] tukar tiket: ${r.status}`, JSON.stringify(r.data).slice(0, 200));
  }
  const draws = Number((await ask('Draw berapa kali? (1 tiket/draw, 0 = skip): ')).trim()) || 0;
  if (draws > 0) {
    const r = await api('/api/v1/points/draw', {
      method: 'POST', token, body: { count: draws },
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    });
    console.log(`[draw] hasil: ${r.status}`, JSON.stringify(r.data).slice(0, 400));
  }
}

// ---------- mode 3: daily check-in (on-chain) ----------
// Check-in harian XP: 1 tx on-chain BSC (gas BNB saja, no value).
// Kirim langsung tanpa konfirmasi, per instruksi Rime 2026-11-24.
const BSC_RPC = 'https://bsc-dataseed.binance.org';
const CHECKIN_ABI = ['function checkIn(bytes32 checkInId)'];

async function doDailyCheckIn(w, token) {
  const e = await api('/api/v1/points/experience', { token });
  if (e.status !== 200) { console.log(`[daily] experience ${e.status}`, JSON.stringify(e.data).slice(0, 200)); return; }
  const ci = e.data.checkIn || {};
  const reward = ci.rewards?.[(ci.cycleDay ?? 1) - 1];
  if (ci.claimedToday) { console.log(`[daily] udah check-in hari ini (streak ${ci.streak ?? 0})`); return; }
  const it = await api('/api/v1/points/experience/check-in/intent', { token });
  if (it.status !== 200 || !it.data?.checkInId) { console.log(`[daily] intent ${it.status}`, JSON.stringify(it.data).slice(0, 200)); return; }
  const { checkInId, contractAddress } = it.data;
  const provider = new JsonRpcProvider(BSC_RPC);
  const signer = w.connect(provider);
  const contract = new Contract(contractAddress, CHECKIN_ABI, signer);
  let gas;
  try { gas = await contract.checkIn.estimateGas(checkInId); }
  catch (err) { console.log(`[daily] estimasi gas gagal: ${String(err.message || err).slice(0, 200)}`); return; }
  const fee = await provider.getFeeData();
  console.log(`[daily] hari ke-${ci.cycleDay ?? '?'} streak=${ci.streak ?? 0} reward=${reward ?? '?'} XP, gas ~${formatEther(gas * (fee.gasPrice ?? 0n))} BNB — kirim tx...`);
  const tx = await contract.checkIn(checkInId);
  const rc = await tx.wait();
  const cf = await api('/api/v1/points/experience/check-in', {
    method: 'POST', token, body: { check_in_id: checkInId, tx_hash: tx.hash },
  });
  console.log(`[daily] OK: tx ${tx.hash} (block ${rc.blockNumber}), konfirmasi ${cf.status} ${JSON.stringify(cf.data).slice(0, 200)}`);
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
  console.log('1) Quests (connect X, tweet, referral, claim)');
  console.log('2) Quiz & Draw (quiz otomatis + tukar tiket + draw)');
  console.log('3) Daily check-in (XP, 1 tx on-chain BSC — tanya dulu sebelum kirim)');
  const mode = (await ask('Pilih mode (1/2/3): ')).trim() || '1';

  // --- satu mode: jalanin semua step per akun ---
  // kode referral: kalau REF_CODE kosong, pakai kode akun pertama yang dijalankan
  let firstCode = refCode;

  for (const i of idxs) {
    const w = wallets[i];
    console.log(`\n===== Akun ${i + 1}/${wallets.length}: ${w.address} =====`);
    try {
      const { token, overview } = await login(w);
      console.log('[login] OK');
      if (mode === '2') {
        await doQuiz(w, token);
        await doDraw(w, token);
      } else if (mode === '3') {
        await doDailyCheckIn(w, token);
      } else {
        await doConnectX(w, token, xAccounts[i]);
        const ov = await doOverview(w, token, overview);
        if (!firstCode && ov?.referral?.invite_code) firstCode = ov.referral.invite_code;
        await doQuests(w, token);
        await doReferralBind(w, token, firstCode);
        await doTweet(w, token, tweetUrls[i], xAccounts[i], ov?.referral?.invite_code);
        await doClaim(w, token);
      }
    } catch (e) {
      console.log(`[error] ${e.message}`);
    }
    await sleep(800);
  }
  rl.close();
  console.log('\nSelesai.');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
