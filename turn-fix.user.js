// ==UserScript==
// @name         크랙 턴 번호 정리
// @namespace    turn-fix.crack
// @version      1.2.0
// @description  AI 답변 상태줄의 턴 숫자가 틀리거나 비어 있을 때, 대화 순서대로 다시 세서 그 숫자만 고쳐 줍니다. 날짜·시간·나머지 글은 건드리지 않아요.
// @match        https://crack.wrtn.ai/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @run-at       document-idle
// ==/UserScript==

/*
 * 사용법
 *  1) 채팅방에서 오른쪽 아래 # 버튼을 누릅니다.
 *  2) AI 답변 맨 위 HUD를 복사해서 붙여넣고, 그중 턴 숫자를 누릅니다.
 *  3) "틀린 번호 찾기" → 목록 확인 → "모두 고치기".
 *
 * 턴 세는 법: 내 메시지 + 그 뒤 AI 답변 = 1턴. 처음 AI가 먼저 띄우는 인사는 0턴(시작)이에요.
 * 비용: 크랙에 이미 로그인된 내 계정으로 크랙 서버만 사용합니다. 외부 AI API를 쓰지 않아서 돈이 들지 않아요.
 */
(function () {
  'use strict';
  if (window.__CRACK_TURN_FIX__) return;
  window.__CRACK_TURN_FIX__ = true;

  // ── 확장 프로그램 호환 (탬퍼몽키: GM_*, 아이폰 Userscripts: GM.*) ──
  const hasGM = typeof GM !== 'undefined' && GM;
  const gmRequest = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest
    : (hasGM && GM.xmlHttpRequest ? o => GM.xmlHttpRequest(o) : null);
  async function getValue(key, fallback) {
    if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    if (hasGM && GM.getValue) return GM.getValue(key, fallback);
    try { const v = localStorage.getItem('turn-fix:' + key); return v === null ? fallback : v; } catch (_) { return fallback; }
  }
  async function setValue(key, value) {
    if (typeof GM_setValue === 'function') return GM_setValue(key, value);
    if (hasGM && GM.setValue) return GM.setValue(key, value);
    try { localStorage.setItem('turn-fix:' + key, value); } catch (_) {}
  }
  const readJSON = async (key, fb) => { try { return JSON.parse(String(await getValue(key, '') || '')) ?? fb; } catch (_) { return fb; } };

  // ── 크랙 서버 ──
  const msgId = m => String(m?._id || m?.id || m?.messageId || '');
  const msgRole = m => String(m?.role || m?.speaker || '');
  const msgText = m => (typeof m?.content === 'string' && m.content) || (typeof m?.message === 'string' && m.message) || '';
  const isChat = m => ['user', 'assistant'].includes(msgRole(m));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function chatIdFromPath() {
    const p = location.pathname;
    const m = p.match(/^\/stories\/[^/]+\/episodes\/([^/?#]+)/) ||
              p.match(/^\/characters\/[^/]+\/chats\/([^/?#]+)/) ||
              p.match(/^\/u\/[^/]+\/c\/([^/?#]+)/);
    return m ? m[1] : null;
  }
  function token() {
    const c = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('access_token='));
    if (!c) throw new Error('크랙 로그인 정보를 찾지 못했어요. 로그인 후 새로고침해 주세요.');
    return decodeURIComponent(c.slice('access_token='.length));
  }
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      if (!gmRequest) { reject(new Error('확장 프로그램이 요청을 허용하지 않았어요.')); return; }
      gmRequest({
        method, url, timeout: 30000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + token(), platform: 'web' },
        data: body === undefined ? undefined : JSON.stringify(body),
        onload: r => {
          let data = null;
          try { data = r.responseText ? JSON.parse(r.responseText) : null; } catch (_) {}
          if (r.status >= 200 && r.status < 300) resolve(data); else reject(new Error('HTTP ' + r.status));
        },
        ontimeout: () => reject(new Error('응답 시간이 초과됐어요.')),
        onerror: () => reject(new Error('네트워크 요청에 실패했어요.')),
      });
    });
  }
  async function readAll(chatId) {
    const out = []; let cursor = '';
    for (let page = 0; page < 60; page++) {
      const res = await request('GET', `https://crack-api.wrtn.ai/crack-gen/v3/chats/${chatId}/messages?limit=50` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
      const data = res?.data || res, list = Array.isArray(data?.messages) ? data.messages : [];
      out.push(...list);
      cursor = data?.nextCursor == null ? '' : String(data.nextCursor);
      if (!cursor || data?.hasNext === false) break;
    }
    if (out.every(m => m.createdAt)) out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); else out.reverse();
    return out.filter(isChat);
  }
  async function readMessage(chatId, id) {
    const res = await request('GET', `https://crack-api.wrtn.ai/crack-gen/v3/chats/${chatId}/messages/${id}`);
    return res?.data || res;
  }
  async function writeMessage(chatId, id, next) {
    let err = null;
    for (const url of [`https://contents-api.wrtn.ai/character-chat/v3/chats/${chatId}/messages/${id}`,
                       `https://crack-api.wrtn.ai/crack-gen/v3/chats/${chatId}/messages/${id}`]) {
      try {
        await request('PATCH', url, { message: next });
        if (msgText(await readMessage(chatId, id)) === next) return;
        err = new Error('저장했지만 내용이 바뀌지 않았어요.');
      } catch (e) { err = e; }
    }
    throw err || new Error('메시지를 고치지 못했어요.');
  }

  // 다른 스크립트가 답변 끝에 숨겨 둔 노트는 찾기·고치기에서 빼고 그대로 둡니다.
  const HIDDEN = [/\n*\[\/\/\]: # "MEMO_NOTE v3[^\n]*\n[\s\S]*?\n[ \t]*MEMO_NOTE_END"/g,
    /\n*\[\/\/\]: # \(MEMO_NOTE v2[^\n]*\)\n(?:\[\/\/\]: # \([^\n]*\)\n?)*?\[\/\/\]: # \(MEMO_NOTE_END\)/g,
    /\n*<!--MEMO_NOTE[\s\S]*?MEMO_NOTE_END-->/g];
  const stripHidden = t => HIDDEN.reduce((s, re) => s.replace(re, ''), String(t || ''));

  // ── 규칙: 예시에서 고른 숫자의 바로 앞 글자 · 바로 뒤 글자 ──
  //   [#125턴｜3월 12일]    → "#" 뒤 · "턴" 앞   (3월·12일은 앞뒤 글자가 달라서 안 잡힘)
  //   📜 1장 · 10.28 木     → "📜" 뒤 · "장" 앞
  //   [ SAT 12 | T10 | 1942.12.24 ] → "T" 뒤 (SAT의 T는 앞에 영어가 붙어 있어서 무시)
  const HEAD = 400; // 답변 맨 앞 몇 글자 안에서만 찾을지
  const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const SEP = '\\s\\d|｜¦·•・,，.:;/\\\\()\\[\\]{}<>「」『』【】〔〕';
  const BLANK = '[—–―\\-?？]{1,3}'; // AI가 숫자 대신 쓴 빈칸 표시
  const numbersIn = s => [...String(s).matchAll(/\d+/g)].map(m => ({ value: m[0], index: m.index }));
  function ruleRe(r) {
    const lead = r.pre ? `${/^[A-Za-z]/.test(r.pre) ? '(?<![A-Za-z])' : ''}${reEsc(r.pre)}\\s*` : '(?<![\\d.:/])';
    const num = r.suf ? `(\\d+|${BLANK})` : `(\\d+(?![\\d.:/])|${BLANK}(?!\\d))`;
    return new RegExp(lead + num + (r.suf ? `\\s*${reEsc(r.suf)}` : ''), 'du');
  }
  function findIn(head, rule) {
    const m = ruleRe(rule).exec(head);
    if (!m) return null;
    const blank = !/^\d+$/.test(m[1]);
    return { value: blank ? null : Number(m[1]), blank, start: m.indices[1][0], len: m[1].length };
  }
  const findTurn = (text, rule) => findIn(stripHidden(text).slice(0, HEAD), rule);
  function ruleFrom(example, idx) {
    const n = numbersIn(example)[idx];
    if (!n) return null;
    const before = example.slice(0, n.index), after = example.slice(n.index + n.value.length);
    const preM = before.match(new RegExp(`([^${SEP}]+)\\s*$`, 'u'));
    const sufM = after.match(new RegExp(`^\\s*([^${SEP}]+)`, 'u'));
    const pre = preM ? [...preM[1]].slice(-3).join('') : '';
    const suf = sufM ? [...sufM[1]].slice(0, 2).join('') : '';
    // 예시 줄에서 고른 숫자를 '처음으로' 찾는 규칙만 씁니다. 앞뒤 둘 다 쓰는 규칙부터 시험해요.
    for (const r of [{ pre, suf }, { pre, suf: '' }, { pre: '', suf }]) {
      if (!r.pre && !r.suf) continue;
      const f = findIn(example, r);
      if (f && f.start === n.index) return r;
    }
    return null;
  }
  const ruleLabel = r => r.pre && r.suf ? `"${r.pre}" 뒤 · "${r.suf}" 앞 숫자` : r.pre ? `"${r.pre}" 바로 뒤 숫자` : `"${r.suf}" 바로 앞 숫자`;

  // ── 훑어보기: 내 메시지마다 1턴씩 세고, 답변에 적힌 숫자와 비교 ──
  //    "턴으로 안 셈"으로 고른 답변(보고서 등)은 그 턴을 건너뛰고 뒤 번호를 하나씩 당겨요.
  function compute(all, rule, base, skip) {
    const groups = []; let cur = null;
    for (const m of all) {
      if (msgRole(m) === 'user') { cur = { replies: [] }; groups.push(cur); continue; }
      if (cur) cur.replies.push(m); // 첫 인사(0턴)는 건너뜀
    }
    let t = 0;
    for (const g of groups) { const counted = !g.replies.some(r => skip.has(msgId(r))); if (counted) t++; g.turn = counted ? t : null; }
    const rows = [], missing = [];
    for (const g of groups) for (const m of g.replies) {
      const f = findTurn(msgText(m), rule);
      if (f) { if (g.turn != null) rows.push({ id: msgId(m), counted: g.turn, f, text: msgText(m) }); }
      else missing.push({ id: msgId(m), counted: g.turn, text: msgText(m) });
    }
    const last = rows[rows.length - 1];
    const offset = last && base != null ? base - last.counted : 0;
    rows.forEach(r => { r.want = r.counted + offset; });
    missing.forEach(r => { r.want = r.counted == null ? null : r.counted + offset; });
    return { all, rows, missing, wrong: rows.filter(r => r.want >= 1 && r.f.value !== r.want) };
  }

  // ── HUD가 없는 답변 맨 위에 넣을 줄: 붙여넣은 HUD에서 턴 부분만 같은 모양으로 ──
  //   [#125턴｜3월 12일…]  → [#57턴]
  //   📜 1장 · 10.28 木   → 📜 57장
  //   ```𝙉𝙊𝙒＿𝗧12｜…```   → ```𝙉𝙊𝙒＿𝗧57```
  const PAIRS = { '[': ']', '(': ')', '【': '】', '「': '」', '『': '』', '〔': '〕', '{': '}', '<': '>' };
  function hudLine(example, idx, rule, n) {
    const num = numbersIn(example)[idx];
    if (!num) return '';
    const lineStart = example.lastIndexOf('\n', num.index - 1) + 1;
    const sepRe = new RegExp(`[${SEP.replace('\\s\\d', '')}\\n]`, 'u');
    let a = num.index;
    while (a > lineStart && /\s/.test(example[a - 1])) a--;          // 숫자 앞 공백
    while (a > lineStart && !sepRe.test(example[a - 1]) && !/\s/.test(example[a - 1])) a--; // 앞 글자 묶음
    let b = num.index + num.value.length;
    if (rule.suf) { const m = example.slice(b).match(new RegExp('^\\s*' + reEsc(rule.suf), 'u')); if (m) b += m[0].length; }
    let line = (example.slice(a, num.index) + n + example.slice(num.index + num.value.length, b)).trim();
    const first = example.slice(lineStart).trimStart()[0];
    if (PAIRS[first] && a > lineStart) line = first + line + PAIRS[first];
    const fenced = (example.slice(0, lineStart).match(/```/g) || []).length % 2 === 1;
    return fenced ? '```\n' + line + '\n```' : line;
  }

  // ══════════════════════════════════════════════════════════════
  // 화면
  // ══════════════════════════════════════════════════════════════
  const host = document.createElement('div');
  host.id = 'turn-fix-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial;--bg:#F7F6FB;--card:#fff;--line:#ECEAF3;--fg:#24212F;--fg2:#45414F;--mute:#8A8698;--ac:#6E5BE0;--acs:#F0EDFD;--ok:#2E8B67;--oks:#E5F5EE;--bad:#B4485E;--bads:#FCEDF0}
    *{box-sizing:border-box;font-family:'Pretendard','Apple SD Gothic Neo','Noto Sans KR',system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
    button{font:inherit;color:inherit;cursor:pointer}
    .fab{position:fixed;right:12px;bottom:170px;z-index:2147483000;width:40px;height:40px;border-radius:20px;border:1px solid var(--line);background:#fff;color:var(--ac);
      display:none;align-items:center;justify-content:center;font-size:17px;font-weight:800;box-shadow:0 6px 18px rgba(30,30,80,.14)}
    .fab.show{display:flex}
    .dim{position:fixed;inset:0;z-index:2147483001;background:rgba(20,18,40,.32);display:none}
    .sheet{position:fixed;left:0;right:0;bottom:0;z-index:2147483002;max-height:88vh;background:var(--bg);border-radius:20px 20px 0 0;display:none;flex-direction:column;overflow:hidden;color:var(--fg)}
    :host(.open) .dim{display:block} :host(.open) .sheet{display:flex}
    .hd{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;background:var(--bg)}
    .hd b{flex:1;font-size:16px}
    .x{all:unset;width:34px;height:34px;border-radius:17px;background:#fff;display:flex;align-items:center;justify-content:center;border:1px solid var(--line);color:var(--fg2);font-size:18px;cursor:pointer}
    .body{overflow-y:auto;overflow-x:hidden;padding:4px 14px 28px;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;margin-bottom:10px}
    .card h3{margin:0 0 4px;font-size:14px}
    .note{font-size:12.5px;line-height:1.55;color:var(--mute)}
    textarea{width:100%;min-height:64px;margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:9px 10px;font-size:13px;line-height:1.5;color:var(--fg);background:#FCFCFE;resize:vertical}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .chips button{min-width:40px;height:34px;padding:0 10px;border-radius:10px;border:1px solid var(--line);background:#fff;font-size:14px;font-weight:700;color:var(--fg2)}
    .chips button[aria-pressed="true"]{background:var(--ac);border-color:var(--ac);color:#fff}
    .rule{margin-top:10px;padding:8px 10px;border-radius:10px;background:var(--oks);color:var(--ok);font-size:12.5px;font-weight:600}
    .btn{all:unset;box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:100%;height:44px;margin-top:10px;border-radius:12px;background:#fff;border:1px solid var(--line);font-size:14px;font-weight:700;color:var(--fg);cursor:pointer}
    .btn.pri{background:var(--fg);border-color:var(--fg);color:#fff}
    .btn[disabled]{opacity:.45;pointer-events:none}
    .base{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--fg2)}
    .base input{width:80px;height:38px;border:1px solid var(--line);border-radius:10px;padding:0 10px;font-size:15px;font-weight:700;color:var(--fg)}
    .base .btn{width:auto;height:38px;margin:0 0 0 auto;padding:0 12px;font-size:13px}
    .list{margin-top:8px;border-top:1px solid var(--line)}
    .fx{display:grid;grid-template-columns:auto auto auto minmax(0,1fr);align-items:center;gap:6px;padding:8px 0;border-bottom:1px solid var(--line);font-size:13px}
    .from{color:var(--bad);background:var(--bads);border-radius:6px;padding:2px 6px;font-weight:700;text-decoration:line-through}
    .from.blank{text-decoration:none}
    .to{color:var(--ok);background:var(--oks);border-radius:6px;padding:2px 6px;font-weight:700}
    .ctx{color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:12px}
    .miss{padding:10px 0;border-bottom:1px solid var(--line)}
    .mctx{font-size:12.5px;color:var(--fg2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mrow{display:flex;align-items:center;gap:6px;margin-top:7px;min-width:0}
    .hudprev{flex:1;min-width:0;font-size:12.5px;font-weight:700;color:var(--ac);background:var(--acs);border-radius:6px;padding:3px 7px;white-space:pre;overflow:hidden;text-overflow:ellipsis}
    .hudprev.off{color:var(--mute);background:#F2F1F5;text-decoration:line-through}
    .tg{all:unset;flex-shrink:0;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--line);background:#fff;font-size:12px;font-weight:700;color:var(--mute);cursor:pointer}
    .tg[aria-pressed="true"]{background:var(--fg);border-color:var(--fg);color:#fff}
    .tg[disabled]{opacity:.35;pointer-events:none}
    .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483003;max-width:88vw;padding:10px 14px;border-radius:12px;background:var(--fg);color:#fff;font-size:13px;line-height:1.45;display:none;text-align:center}
    .toast.show{display:block} .toast.err{background:var(--bad)}
  </style>
  <button class="fab" aria-label="턴 번호 정리">#</button>
  <div class="dim"></div>
  <div class="sheet" role="dialog" aria-label="턴 번호 정리">
    <div class="hd"><b>턴 번호 정리</b><button class="x" aria-label="닫기">×</button></div>
    <div class="body"></div>
  </div>
  <div class="toast"></div>`;
  const $ = s => root.querySelector(s);
  const st = { example: '', pick: -1, rule: null, result: null, base: null, busy: false, undoN: 0, skip: new Set(), noIns: new Set() };

  let toastTimer = null;
  function toast(msg, kind = '', ms = 2600) {
    const t = $('.toast'); t.textContent = msg; t.className = 'toast show ' + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const chips = () => {
    const nums = numbersIn(st.example);
    return nums.length ? `<div class="note" style="margin-top:10px">이 중에 <b>턴 숫자</b>를 눌러 주세요</div>
      <div class="chips">${nums.map((n, i) => `<button data-act="pick" data-i="${i}" aria-pressed="${i === st.pick}">${esc(n.value)}</button>`).join('')}</div>` : '';
  };
  function html() {
    const undo = st.undoN ? `<section class="card"><h3>방금 고친 답변 ${st.undoN}개</h3>
      <div class="note">이상하게 바뀌었으면 고치기 전 글로 그대로 되돌려요.</div>
      <button class="btn" data-act="undo"${st.busy ? ' disabled' : ''}>되돌리기</button></section>` : '';
    const s1 = `<section class="card"><h3>1. HUD 붙여넣기</h3>
      <div class="note">AI 답변 맨 위에 매번 나오는 HUD를 복사해서 넣어 주세요.</div>
      <textarea data-in="ex" placeholder="HUD 붙여넣기">${esc(st.example)}</textarea>
      <div data-out="chips">${chips()}</div>
      ${st.rule ? `<div class="rule">✓ 규칙: ${esc(ruleLabel(st.rule))} · 답변 앞 ${HEAD}자 안에서만 찾아요</div>` : ''}</section>`;
    if (!st.rule) return undo + s1;
    const r = st.result;
    if (!r) return undo + s1 + `<section class="card"><h3>2. 전체 답변 훑어보기</h3>
      <div class="note">내 메시지 + AI 답변 = 1턴으로 처음부터 세요. 날짜·시간·다른 숫자는 건드리지 않아요. HUD가 빠진 답변도 같이 찾아요.</div>
      <button class="btn pri" data-act="scan"${st.busy ? ' disabled' : ''}>${st.busy ? '훑어보는 중…' : '틀린 번호 찾기'}</button></section>`;
    const last = r.rows[r.rows.length - 1];
    const ins = insertList(r), skipN = r.missing.filter(m => m.counted == null).length;
    const missCard = r.missing.length ? `<section class="card"><h3>4. HUD 없는 답변 ${r.missing.length}개</h3>
        <div class="note">보고서처럼 HUD 없이 온 답변이에요. 턴 숫자만 HUD 모양으로 맨 위에 넣을 수 있어요. <b>턴으로 안 셈</b>을 고르면 그 턴은 건너뛰고 뒤 번호가 하나씩 당겨져요.</div>
        <div class="list">${r.missing.slice(-60).reverse().map(m => {
          const counted = m.counted != null, on = counted && !st.noIns.has(m.id);
          return `<div class="miss"><div class="mctx">${esc(stripHidden(m.text).trim().replace(/\s+/g, ' ').slice(0, 60)) || '(빈 답변)'}</div>
            <div class="mrow"><span class="hudprev${on ? '' : ' off'}">${counted ? esc(hudLine(st.example, st.pick, st.rule, m.want)) : '번호 없음'}</span>
              <button class="tg" data-act="ins" data-id="${esc(m.id)}" aria-pressed="${on}"${counted ? '' : ' disabled'}>HUD 넣기</button>
              <button class="tg" data-act="cnt" data-id="${esc(m.id)}" aria-pressed="${counted}">턴으로 셈</button></div></div>`;
        }).join('')}</div>
        ${r.missing.length > 60 ? `<div class="note" style="margin-top:6px">최근 60개만 보여요.</div>` : ''}</section>` : '';
    const total = r.wrong.length + ins.length;
    return undo + s1 + `<section class="card"><h3>2. 기준 확인</h3>
        <div class="note">답변 ${r.rows.length}개에서 턴 숫자를 찾았어요${skipN ? ` · ${skipN}턴은 안 세요` : ''}. 가장 최근 답변을 몇 턴으로 할까요? 그 앞은 순서대로 하나씩 줄여서 맞춰요.</div>
        <div class="base"><input type="number" inputmode="numeric" data-in="base" value="${last ? last.want : ''}"><span>턴</span>
          <button class="btn" data-act="rebase">다시 계산</button></div></section>
      <section class="card"><h3>3. 고칠 답변 ${r.wrong.length}개</h3>
        ${r.wrong.length ? `<div class="note">적힌 숫자 → 고칠 숫자</div><div class="list">${r.wrong.slice(-60).reverse().map(w => `<div class="fx">
            <span class="from${w.f.blank ? ' blank' : ''}">${w.f.blank ? '빈칸' : w.f.value}</span><span>→</span><span class="to">${w.want}</span>
            <span class="ctx">${esc(stripHidden(w.text).slice(Math.max(0, w.f.start - 6), w.f.start + 26))}</span></div>`).join('')}</div>
          ${r.wrong.length > 60 ? `<div class="note" style="margin-top:6px">최근 60개만 보여요. 고치기는 ${r.wrong.length}개 전부 해요.</div>` : ''}`
          : `<div class="note">HUD가 있는 답변은 번호가 모두 맞아요.</div>`}</section>
      ${missCard}
      ${total ? `<section class="card"><button class="btn pri" style="margin-top:0" data-act="apply"${st.busy ? ' disabled' : ''}>${[r.wrong.length ? `${r.wrong.length}개 고치기` : '', ins.length ? `${ins.length}개 HUD 넣기` : ''].filter(Boolean).join(' · ')}</button>
        <div class="note" style="margin-top:8px">숫자 자리만 바꾸거나 맨 위에 한 줄만 넣고, 다시 읽어서 확인해요. 새로고침하면 화면에도 보여요.</div></section>` : ''}`;
  }
  const insertList = r => r.missing.filter(m => m.counted != null && m.want >= 1 && !st.noIns.has(m.id));
  function render() {
    const body = $('.body'), top = body.scrollTop;
    body.innerHTML = html();
    body.scrollTop = top;
  }

  async function loadRoom() {
    const cid = chatIdFromPath();
    const saved = await readJSON('rule:' + cid, null);
    Object.assign(st, { example: '', pick: -1, rule: null, result: null, base: null });
    if (saved?.rule) Object.assign(st, { rule: saved.rule, example: saved.example || '', pick: saved.pick ?? -1 });
    st.undoN = (await readJSON('undo:' + cid, [])).length;
    st.skip = new Set(await readJSON('skip:' + cid, [])); st.noIns = new Set();
  }
  async function open() {
    await loadRoom();
    host.classList.add('open'); fitSheet(); render();
  }
  const close = () => host.classList.remove('open');
  function fitSheet() {
    const vv = window.visualViewport, sh = $('.sheet');
    if (!vv) return;
    sh.style.maxHeight = Math.round(vv.height * 0.88) + 'px';
    sh.style.bottom = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px';
  }
  window.visualViewport?.addEventListener('resize', () => host.classList.contains('open') && fitSheet());

  $('.fab').addEventListener('click', open);
  $('.dim').addEventListener('click', close);
  $('.x').addEventListener('click', close);
  root.addEventListener('input', e => {
    if (e.target.dataset?.in !== 'ex') return;
    st.example = e.target.value; st.pick = -1; st.rule = null; st.result = null;
    root.querySelector('[data-out="chips"]').innerHTML = chips();
    root.querySelector('.rule')?.remove();
    root.querySelectorAll('.card').forEach((c, i) => { if (i > (st.undoN ? 1 : 0)) c.remove(); });
  });
  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act, cid = chatIdFromPath();
    if (!cid) return;
    if (act === 'pick') {
      st.pick = Number(b.dataset.i); st.rule = ruleFrom(st.example, st.pick); st.result = null; st.base = null;
      if (st.rule) await setValue('rule:' + cid, JSON.stringify({ rule: st.rule, example: st.example, pick: st.pick }));
      else toast('그 숫자는 앞뒤 글자로 구분이 안 돼요. 다른 숫자를 골라 주세요.', 'err', 3200);
      return render();
    }
    if (act === 'rebase') {
      const v = Number(root.querySelector('[data-in="base"]')?.value); st.base = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
      if (st.result) st.result = compute(st.result.all, st.rule, st.base, st.skip);
      return render();
    }
    if (act === 'ins') { const id = b.dataset.id; st.noIns.has(id) ? st.noIns.delete(id) : st.noIns.add(id); return render(); }
    if (act === 'cnt') {
      const id = b.dataset.id; st.skip.has(id) ? st.skip.delete(id) : st.skip.add(id);
      await setValue('skip:' + cid, JSON.stringify([...st.skip]));
      if (st.result) st.result = compute(st.result.all, st.rule, st.base, st.skip);
      return render();
    }
    if (act === 'scan') {
      st.busy = true; render();
      try {
        st.result = compute(await readAll(cid), st.rule, st.base, st.skip);
        if (!st.result.rows.length) toast('이 규칙으로 찾은 숫자가 없어요. 붙여넣은 HUD를 다시 확인해 주세요.', 'err', 3500);
      } catch (err) { toast('읽기 실패 · ' + err.message, 'err'); }
      st.busy = false; return render();
    }
    if (act === 'apply') return apply(cid);
    if (act === 'undo') return undo(cid);
  });

  async function apply(cid) {
    const r = st.result; if (!r || st.busy) return;
    const jobs = [...r.wrong.map(w => ({ kind: 'fix', id: w.id, want: w.want })),
                  ...insertList(r).map(m => ({ kind: 'ins', id: m.id, want: m.want }))];
    if (!jobs.length) return;
    const nFix = jobs.filter(j => j.kind === 'fix').length, nIns = jobs.length - nFix;
    if (!confirm(`${[nFix ? `답변 ${nFix}개의 턴 숫자 고치기` : '', nIns ? `답변 ${nIns}개 맨 위에 HUD 넣기` : ''].filter(Boolean).join('\n')}\n\n나머지 글은 그대로예요. 진행할까요?`)) return;
    st.busy = true; render();
    const saved = []; let done = 0, fail = 0;
    for (const job of jobs) {
      toast(`고치는 중… ${done + fail + 1}/${jobs.length}`, '', 60000);
      try {
        const want = Math.round(Number(job.want));
        if (!(want >= 1)) { fail++; continue; }
        const cur = msgText(await readMessage(cid, job.id)), f = findTurn(cur, st.rule);
        let next;
        if (job.kind === 'fix') {
          const body = stripHidden(cur);
          if (!f || !cur.startsWith(body)) { fail++; continue; }
          next = body.slice(0, f.start) + want + body.slice(f.start + f.len) + cur.slice(body.length);
        } else {
          if (f) { done++; continue; } // 그 사이 HUD가 생겼으면 건너뜀
          const line = hudLine(st.example, st.pick, st.rule, want);
          if (!line) { fail++; continue; }
          next = line + '\n\n' + cur;
        }
        if (next === cur) { done++; continue; }
        saved.push({ id: job.id, text: cur });
        await setValue('undo:' + cid, JSON.stringify(saved));
        await writeMessage(cid, job.id, next);
        // 다시 읽어서 맞는 숫자가 들어갔는지 확인하고, 아니면 원래 글로 돌려놓아요.
        const g = findTurn(msgText(await readMessage(cid, job.id)), st.rule);
        if (!g || g.value !== want) { await writeMessage(cid, job.id, cur); fail++; continue; }
        done++;
      } catch (_) { fail++; }
    }
    st.busy = false; st.result = null; st.undoN = saved.length;
    toast(`${done}개 고쳤어요${fail ? ` · ${fail}개는 못 고쳤어요` : ''}. 새로고침하면 화면에도 보여요.`, fail ? 'err' : '', 5000);
    render();
  }
  async function undo(cid) {
    const list = await readJSON('undo:' + cid, []);
    if (!list.length || st.busy || !confirm(`답변 ${list.length}개를 고치기 전 글로 되돌릴까요?`)) return;
    st.busy = true; render();
    let ok = 0, bad = 0;
    for (const u of list) { try { await writeMessage(cid, u.id, u.text); ok++; } catch (_) { bad++; } }
    if (!bad) await setValue('undo:' + cid, '[]');
    st.busy = false; st.undoN = bad ? list.length : 0; st.result = null;
    toast(`${ok}개 되돌렸어요${bad ? ` · ${bad}개 실패` : ''}. 새로고침하면 보여요.`, bad ? 'err' : '', 4000);
    render();
  }

  // ── 입력창 줄 안의 작은 # 버튼 ──
  // 입력창 아래 아이콘 줄에서 "울트라챗" 버튼을 찾아, 그 바로 왼쪽에 아이콘 크기로 끼워 넣어요.
  // 못 찾으면 예전처럼 오른쪽 아래 떠 있는 # 버튼을 대신 보여줘요.
  const INLINE_ID = 'turn-fix-inline';
  function findModelButton() {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let best = null, bestY = -1;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.nodeValue.includes('울트라챗')) continue;
      const el = n.parentElement && n.parentElement.closest('button,[role="button"]');
      if (!el || el.id === INLINE_ID) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.top > bestY) { best = el; bestY = r.top; } // 여러 개면 가장 아래쪽(입력창) 것
    }
    return best;
  }
  function ensureInline() {
    const cur = document.getElementById(INLINE_ID);
    const anchor = findModelButton();
    if (!anchor || !anchor.parentElement) return !!(cur && cur.isConnected);
    if (cur && cur.nextElementSibling === anchor) return true;
    const b = cur || document.createElement('button');
    if (!cur) {
      b.id = INLINE_ID; b.type = 'button'; b.textContent = '#'; b.title = '턴 번호 정리'; b.setAttribute('aria-label', '턴 번호 정리');
      b.style.cssText = 'all:unset;box-sizing:border-box;flex:0 0 auto;width:28px;height:28px;margin-right:6px;border-radius:50%;' +
        'border:1px solid rgba(128,128,128,.28);background:transparent;color:#6E5BE0;display:inline-flex;align-items:center;' +
        'justify-content:center;font:800 14px/1 system-ui,sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent';
      b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); open(); });
    }
    anchor.parentElement.insertBefore(b, anchor);
    return true;
  }

  // 채팅방에서만 # 버튼을 보여 줍니다. (크랙은 페이지 이동 없이 주소만 바뀌고 화면도 다시 그려져서 주기적으로 확인)
  let lastPath = '';
  setInterval(() => {
    const inChat = !!chatIdFromPath();
    if (location.pathname !== lastPath) { lastPath = location.pathname; if (!inChat) close(); }
    const placed = inChat && ensureInline();
    if (!inChat) document.getElementById(INLINE_ID)?.remove();
    $('.fab').classList.toggle('show', inChat && !placed);
  }, 800);
})();
