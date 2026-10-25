"use strict";
/* 大小豬錢包前端。沒有 build 步驟，直接被 index.html 載入。
 * 資料都來自後端 API；localStorage 只存登入 token 與「上一次看到的資料」，
 * 讓 Render 冷啟動的那幾十秒內也能先看到畫面。 */

const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? "http://127.0.0.1:5001"
  : "https://piggywallet-backend.onrender.com";
// 跟 TaiwanLARP / ObearSite 共用的 OAuth Client ID（來源同為 obearwu.github.io）
const GOOGLE_CLIENT_ID = "593865088792-hircgnt15vfdeispj3f3qms7gnnpjh6q.apps.googleusercontent.com";

const TOKEN_KEY = "pw.token";
const BOOT_KEY = "pw.bootstrap";
const GROUP_KEY = (id) => `pw.group.${id}`;
const CURRENCIES = ["TWD", "JPY", "USD", "KRW", "EUR", "HKD", "CNY", "THB", "SGD", "MYR",
  "VND", "PHP", "IDR", "GBP", "AUD", "NZD", "CAD", "CHF"];
// 跟後端 wallet/money.py 的 ZERO_DECIMAL_CURRENCIES 一致
const ZERO_DECIMAL = new Set(["TWD", "JPY", "KRW", "VND", "IDR", "CLP", "HUF", "ISK", "UGX"]);
const CATEGORY = {
  food: ["🍜", "吃喝"], transport: ["🚃", "交通"], stay: ["🏨", "住宿"], shopping: ["🛍️", "購物"],
  fun: ["🎡", "娛樂"], home: ["🏠", "居家"], bills: ["🧾", "帳單"], gift: ["🎁", "禮物"], other: ["🐷", "其他"],
};
const GROUP_EMOJIS = ["🐷", "✈️", "🏠", "🍜", "🎡", "🛒", "💕", "🏖️", "🗻", "🎄", "🐶", "🚗"];
const SPLIT_LABEL = { equal: "均分", amount: "自訂金額", ratio: "比例" };

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} },
  json(k) { try { return JSON.parse(this.get(k) || "null"); } catch (e) { return null; } },
};

const state = { me: null, members: [], groups: [], methods: [], detail: null, tab: "list" };

// ===== 小工具 =====

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function decimals(cur) { return ZERO_DECIMAL.has(cur) ? 0 : 2; }
function fmt(amount, cur) {
  const n = Number(amount) || 0;
  const d = decimals(cur);
  try {
    return new Intl.NumberFormat("zh-TW", {
      // symbol 而不是 narrowSymbol：narrowSymbol 會把美金、港幣都顯示成「$」，跟台幣分不出來
      style: "currency", currency: cur, currencyDisplay: "symbol",
      minimumFractionDigits: d, maximumFractionDigits: d,
    }).format(n);
  } catch (e) { return `${cur} ${n.toFixed(d)}`; }
}
function num(v) {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
}
// 用本地時區的日期，不用 toISOString()（那是 UTC，台灣早上 8 點前會變成昨天）
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const week = "日一二三四五六"[date.getDay()];
  const prefix = iso === todayISO() ? "今天 · " : "";
  return `${prefix}${y === new Date().getFullYear() ? "" : y + "/"}${m}/${d}（${week}）`;
}
function memberName(id) {
  const m = state.members.find((x) => x.id === Number(id));
  return m ? m.name : "（已移除）";
}
function partner() { return state.members.find((m) => m.id !== state.me?.id); }
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* 跟後端 money.allocate 同一套最大餘數法，只用來在表單上預覽；
 * 實際存進資料庫的分攤以後端算的為準。 */
function allocate(total, weights, cur, first) {
  const unit = decimals(cur) ? 100 : 1;
  const totalUnits = Math.round(total * unit);
  const ids = Object.keys(weights);
  const sum = ids.reduce((s, id) => s + weights[id], 0);
  if (!(sum > 0)) return {};
  const out = {}; const rem = [];
  ids.forEach((id) => {
    const exact = totalUnits * weights[id] / sum;
    out[id] = Math.floor(exact + 1e-9);
    rem.push([exact - out[id], Number(id) === first ? 0 : 1, Number(id)]);
  });
  let left = totalUnits - ids.reduce((s, id) => s + out[id], 0);
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  for (const [, , id] of rem) { if (left-- <= 0) break; out[id] += 1; }
  ids.forEach((id) => { out[id] /= unit; });
  return out;
}

// ===== API =====

let pending = 0;
let wakeTimer = null;
function trackStart() {
  pending++;
  // 1.5 秒還沒回應，多半是 Render 從休眠中醒來，提示一下
  if (!wakeTimer) wakeTimer = setTimeout(() => { $("wakeBanner").hidden = false; }, 1500);
}
function trackEnd() {
  pending = Math.max(0, pending - 1);
  if (pending === 0) { clearTimeout(wakeTimer); wakeTimer = null; $("wakeBanner").hidden = true; }
}

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data || {}; }
}

// fetch 加上逾時。沒有逾時的話，卡住的請求會一直掛著，畫面就停在「登入中…」
// （2026-10-25 iPhone 冷啟動時實際發生：請求從沒到達伺服器，三分鐘後才失敗）。
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctrl.signal }); } finally { clearTimeout(timer); }
}

/* 確認伺服器醒著。Render 免費方案閒置 15 分鐘會休眠，喚醒要幾十秒；
 * 這段期間送出的請求可能卡住或失敗，所以先用不碰資料庫的 /api/health
 * 把它叫醒、確定能回應，再送真正的請求。最近 10 分鐘內有成功回應過就直接跳過。 */
const AWAKE_FOR_MS = 10 * 60 * 1000;
let lastContact = 0;
let waking = null;

function ensureAwake() {
  if (Date.now() - lastContact < AWAKE_FOR_MS) return Promise.resolve();
  if (waking) return waking;
  waking = (async () => {
    trackStart();
    const deadline = Date.now() + 120_000;
    try {
      while (Date.now() < deadline) {
        try {
          const res = await fetchWithTimeout(API_BASE + "/api/health", {}, 15_000);
          if (res.ok) { lastContact = Date.now(); return; }
        } catch (e) { /* 逾時或連線失敗：還在開機，繼續等 */ }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new ApiError("伺服器一直沒有回應，請稍後再試", 0);
    } finally { trackEnd(); waking = null; }
  })();
  return waking;
}

/* retry：連線失敗或逾時時，先確認伺服器醒著再重送幾次。只給「重送也不會
 * 多記一筆帳」的請求用（讀取、登入）；新增支出這類寫入不自動重送，因為第一次
 * 可能其實已經寫進去、只是回應沒收到。寫入前的 ensureAwake 已經避開冷啟動。 */
async function api(path, { method = "GET", body, retry = method === "GET" ? 2 : 0 } = {}) {
  await ensureAwake();
  const headers = { "Content-Type": "application/json" };
  const token = store.get(TOKEN_KEY);
  if (token) headers.Authorization = `Bearer ${token}`;
  trackStart();
  let res;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetchWithTimeout(API_BASE + path,
          { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, 25_000);
        lastContact = Date.now();
        break;
      } catch (e) {
        if (attempt >= retry) throw new ApiError("連不上伺服器，請確認網路後再試一次", 0);
        lastContact = 0;
        await ensureAwake();
      }
    }
  } finally { trackEnd(); }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && path !== "/auth/login") {
    signOutLocal();
    showLogin("登入已逾期，請重新登入");
    throw new ApiError(data.error || "請重新登入", 401, data);
  }
  if (!res.ok) throw new ApiError(data.error || `發生錯誤（${res.status}）`, res.status, data);
  return data;
}

// ===== 登入 =====

function showLogin(msg) {
  showView("loginView");
  $("loginMsg").textContent = msg || "";
  renderGoogleButton();
}

function renderGoogleButton() {
  if (!window.google || !google.accounts) { setTimeout(renderGoogleButton, 200); return; }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: onGoogleCredential });
  google.accounts.id.renderButton($("googleBtn"), { theme: "outline", size: "large", shape: "pill", text: "signin_with", locale: "zh-TW" });
}

async function onGoogleCredential(resp) {
  $("loginMsg").textContent = "登入中…";
  try {
    // Google 的憑證一小時內都有效，重送只會多建一個 session，可以放心重試
    const data = await api("/auth/login", { method: "POST", body: { id_token: resp.credential }, retry: 2 });
    store.set(TOKEN_KEY, data.session_token);
    $("loginMsg").textContent = "";
    await loadBootstrap();
    route();
  } catch (e) {
    $("loginMsg").textContent = e.status === 403 ? `${e.data.email || "這個帳號"} 不能使用大小豬錢包` : e.message;
  }
}

function signOutLocal() {
  store.set(TOKEN_KEY, null);
  store.set(BOOT_KEY, null);
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("pw.group.")).forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
  Object.assign(state, { me: null, members: [], groups: [], methods: [], detail: null });
}

async function logout() {
  try { await api("/auth/logout", { method: "POST" }); } catch (e) {}
  signOutLocal();
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  location.hash = "";
  showLogin();
}

// ===== 資料載入 =====

function applyBootstrap(data) {
  state.me = data.me; state.members = data.members; state.groups = data.groups; state.methods = data.payment_methods;
}

async function loadBootstrap() {
  try {
    const data = await api("/api/bootstrap");
    applyBootstrap(data);
    store.set(BOOT_KEY, JSON.stringify(data));
    $("offlineBanner").hidden = true;
  } catch (e) {
    if (e.status === 401) throw e;
    if (state.me) { $("offlineBanner").hidden = false; return; }
    throw e;
  }
}

// 世代計數：快速切換群組、或連續儲存時，晚回來的舊回應不能蓋掉目前的畫面
let groupSeq = 0;

async function loadGroup(id) {
  const mine = ++groupSeq;
  try {
    const data = await api(`/api/groups/${id}`);
    store.set(GROUP_KEY(id), JSON.stringify(data));
    if (mine !== groupSeq || location.hash !== `#/g/${id}`) return;
    state.detail = data;
    $("offlineBanner").hidden = true;
  } catch (e) {
    if (e.status === 401) throw e;
    if (state.detail && state.detail.group.id === id) { $("offlineBanner").hidden = false; return; }
    throw e;
  }
}

// ===== 畫面切換 =====

function showView(id) {
  for (const v of ["loginView", "homeView", "groupView", "settingsView"]) $(v).hidden = v !== id;
  window.scrollTo(0, 0);
}

async function route() {
  if (!store.get(TOKEN_KEY)) { showLogin(); return; }
  const hash = location.hash || "#/";
  const groupMatch = hash.match(/^#\/g\/(\d+)$/);
  try {
    // 直接開群組或設定網址、又沒有快取時，先拿到「我是誰、有哪些成員」
    if (!state.me) await loadBootstrap();
    if (groupMatch) {
      const id = Number(groupMatch[1]);
      const cached = store.json(GROUP_KEY(id));
      if (cached) { state.detail = cached; renderGroup(); }
      else {
        // 沒有快取時先清掉上一個群組的畫面，不要讓它在載入期間冒充這個群組
        state.detail = null;
        $("groupTitle").textContent = "";
        $("balanceCard").innerHTML = "";
        $("tabList").innerHTML = `<div class="empty">載入中…</div>`;
        $("tabStats").innerHTML = "";
      }
      showView("groupView");
      await loadGroup(id);
      renderGroup();
    } else if (hash === "#/settings") {
      showView("settingsView");
      renderSettings();
    } else {
      showView("homeView");
      renderHome();
      await loadBootstrap();
      renderHome();
    }
  } catch (e) {
    if (e.status !== 401) toast(e.message);
    if (e.status === 404) location.hash = "#/";
  }
}

// ===== 首頁 =====

function myNet(group) { return num(group.net?.[String(state.me?.id)] ?? 0); }

function netText(amount, cur, who) {
  const q = decimals(cur) ? 0.005 : 0.5;
  if (amount > q) return `<span class="owed">${esc(who)}欠你 ${fmt(amount, cur)}</span>`;
  if (amount < -q) return `<span class="owe">你欠${esc(who)} ${fmt(-amount, cur)}</span>`;
  return `<span class="muted">已結清</span>`;
}

function renderHome() {
  if (!state.me) return;
  const p = partner();
  const pName = p ? p.name : "對方";
  const active = state.groups.filter((g) => !g.archived);
  const archived = state.groups.filter((g) => g.archived);

  // 跨群組加總只加同一種結算幣別，不同幣別各列一行
  const totals = {};
  active.forEach((g) => { totals[g.base_currency] = (totals[g.base_currency] || 0) + myNet(g); });
  const lines = Object.entries(totals);
  const q = 0.5;
  let headline = "全部結清 🎉";
  if (lines.length && lines.some(([, v]) => Math.abs(v) > q)) {
    headline = lines.filter(([, v]) => Math.abs(v) > q).map(([cur, v]) =>
      v > 0 ? `${esc(pName)}欠你 ${fmt(v, cur)}` : `你欠${esc(pName)} ${fmt(-v, cur)}`).join("<br>");
  }
  $("overall").innerHTML = `<div class="overall-card"><div class="label">嗨，${esc(state.me.name)} 👋 目前總計</div>
    <div class="amount">${headline}</div></div>`;

  const card = (g) => `<li><button class="group-card" data-group="${g.id}">
      <span class="emoji">${esc(g.emoji)}</span>
      <span class="info"><span class="name">${esc(g.name)}</span>
        <span class="sub">總支出 ${fmt(g.total, g.base_currency)}</span></span>
      <span class="net">${netText(myNet(g), g.base_currency, pName)}</span></button></li>`;
  $("groupList").innerHTML = active.length ? active.map(card).join("")
    : `<li class="empty"><div class="big">🐷</div>還沒有群組，先建一個吧！<br><span class="small">例如「日常開銷」、「東京旅行」</span></li>`;
  $("archivedWrap").hidden = !archived.length;
  $("archivedList").innerHTML = archived.map(card).join("");
}

// ===== 群組頁 =====

function renderGroup() {
  const d = state.detail;
  if (!d || !state.me) return;
  const g = d.group;
  const cur = g.base_currency;
  $("groupTitle").textContent = `${g.emoji} ${g.name}`;

  const transfers = d.transfers || [];
  let html;
  if (!transfers.length) {
    html = `<div class="headline">已結清 🎉</div>`;
  } else {
    html = transfers.map((t) => {
      const methods = state.methods.filter((m) => m.user_id === t.to);
      const isMe = t.from === state.me.id;
      return `<div class="headline">${isMe ? "你" : esc(memberName(t.from))} 要給 ${t.to === state.me.id ? "你" : esc(memberName(t.to))}
        <span class="${isMe ? "owe" : "owed"}">${fmt(t.amount, cur)}</span></div>
        <div class="transfer"><span class="small muted">結清後就記一筆還款</span>
          <button class="btn small" data-settle="${t.from},${t.to},${t.amount}">記還款</button></div>
        ${methods.length ? `<div class="pay-methods">${esc(memberName(t.to))}的收款方式：${methods.map((m) =>
          `<b>${esc(m.label)}</b>${m.detail ? " " + esc(m.detail) : ""}`).join("、")}</div>` : ""}`;
    }).join("");
  }
  $("balanceCard").innerHTML = `${html}<div class="meta"><span>總支出 ${fmt(d.total || 0, cur)}</span><span>結算幣別 ${esc(cur)}</span></div>`;

  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  $("tabList").hidden = state.tab !== "list";
  $("tabStats").hidden = state.tab !== "stats";
  renderActivity(d, cur);
  renderStats(d, cur);
}

function renderActivity(d, cur) {
  const rows = [
    ...d.expenses.map((e) => ({ kind: "e", date: e.spent_on, at: e.created_at, data: e })),
    ...d.settlements.map((s) => ({ kind: "s", date: s.settled_on, at: s.created_at, data: s })),
  ].sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at));
  if (!rows.length) {
    $("tabList").innerHTML = `<div class="empty"><div class="big">🧾</div>還沒有任何帳<br><span class="small">按右下角的 ＋ 記第一筆</span></div>`;
    return;
  }
  let lastDay = "";
  const me = state.me.id;
  $("tabList").innerHTML = rows.map((r) => {
    let head = "";
    if (r.date !== lastDay) { lastDay = r.date; head = `<div class="day">${dayLabel(r.date)}</div>`; }
    if (r.kind === "s") {
      const s = r.data;
      return `${head}<button class="item settle" data-settlement="${s.id}">
        <span class="cat">💸</span>
        <span class="info"><span class="title">${esc(memberName(s.from_user))} 還給 ${esc(memberName(s.to_user))}</span>
          <span class="sub">${esc(s.method || "還款")}${s.note ? " · " + esc(s.note) : ""}</span></span>
        <span class="right"><span class="amt">${fmt(s.amount, cur)}</span></span></button>`;
    }
    const e = r.data;
    const myShare = num((e.shares.find((s) => s.user_id === me) || {}).base || 0);
    const paidByMe = e.paid_by === me;
    const lent = paidByMe ? num(e.base_amount) - myShare : 0;
    let mine = `<span class="mine muted">沒有你的份</span>`;
    if (paidByMe && lent > 0) mine = `<span class="mine owed">借出 ${fmt(lent, cur)}</span>`;
    else if (paidByMe) mine = `<span class="mine muted">自己的</span>`;
    else if (myShare > 0) mine = `<span class="mine owe">你分攤 ${fmt(myShare, cur)}</span>`;
    const foreign = e.currency !== cur ? `<br><span class="mine muted">≈ ${fmt(e.base_amount, cur)}</span>` : "";
    const [icon] = CATEGORY[e.category] || CATEGORY.other;
    return `${head}<button class="item" data-expense="${e.id}">
      <span class="cat">${icon}</span>
      <span class="info"><span class="title">${esc(e.title)}</span>
        <span class="sub">${esc(memberName(e.paid_by))}付 · ${SPLIT_LABEL[e.split_mode]}</span></span>
      <span class="right"><span class="amt">${fmt(e.amount, e.currency)}</span>${foreign}<br>${mine}</span></button>`;
  }).join("");
}

function renderStats(d, cur) {
  if (!d.expenses.length) { $("tabStats").innerHTML = `<div class="empty">記幾筆之後這裡會有統計</div>`; return; }
  const byCat = {};
  const paid = {}; const share = {};
  d.expenses.forEach((e) => {
    byCat[e.category] = (byCat[e.category] || 0) + num(e.base_amount);
    paid[e.paid_by] = (paid[e.paid_by] || 0) + num(e.base_amount);
    e.shares.forEach((s) => { share[s.user_id] = (share[s.user_id] || 0) + num(s.base); });
  });
  const total = num(d.total) || 1;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const bar = (label, v, max) => `<div class="bar-row"><span>${label}</span>
    <span class="bar"><span style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%"></span></span><span>${fmt(v, cur)}</span></div>`;
  const people = state.members.map((m) =>
    `<div class="bar-row"><span>${esc(m.name)}</span><span class="small muted">付 ${fmt(paid[m.id] || 0, cur)}</span>
      <span>分攤 ${fmt(share[m.id] || 0, cur)}</span></div>`).join("");
  $("tabStats").innerHTML = `<div class="stats">
    <div class="stat-block"><h3>分類</h3>${cats.map(([c, v]) => {
      const [icon, name] = CATEGORY[c] || CATEGORY.other;
      return bar(`${icon} ${name}`, v, total);
    }).join("")}</div>
    <div class="stat-block"><h3>誰付了多少</h3>${people}</div></div>`;
}

// ===== 底部表單 =====

function openSheet(html, onMount) {
  $("sheetBody").innerHTML = html;
  $("sheet").hidden = false; $("sheetBackdrop").hidden = false;
  document.body.style.overflow = "hidden";
  if (onMount) onMount($("sheetBody"));
}
function closeSheet() {
  $("sheet").hidden = true; $("sheetBackdrop").hidden = true;
  document.body.style.overflow = "";
  $("sheetBody").innerHTML = "";
}
function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}">${options.map(([v, label]) =>
    `<button type="button" data-v="${esc(v)}" class="${String(v) === String(value) ? "on" : ""}">${label}</button>`).join("")}</div>`;
}
function segValue(root, name) { return root.querySelector(`[data-seg="${name}"] .on`)?.dataset.v; }
function bindSeg(root, onChange) {
  root.querySelectorAll("[data-seg]").forEach((box) => box.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button"); if (!btn) return;
    box.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    if (onChange) onChange(box.dataset.seg, btn.dataset.v);
  }));
}
async function submitting(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

// ---- 支出 ----

function openExpense(expense) {
  const g = state.detail.group;
  const base = g.base_currency;
  const e = expense || {
    title: "", amount: "", currency: base, paid_by: state.me.id, split_mode: "equal", category: "food",
    spent_on: todayISO(), note: "", fx_rate: "1", fx_source: "same",
    shares: state.members.map((m) => ({ user_id: m.id, input: "1" })),
  };
  const currencies = [...new Set([base, ...CURRENCIES, e.currency])];
  const inputOf = (uid) => (e.shares.find((s) => s.user_id === uid) || {}).input;
  const included = (uid) => e.shares.some((s) => s.user_id === uid);
  const shareRows = state.members.map((m) => `<div class="share-row" data-uid="${m.id}">
      <input type="checkbox" ${included(m.id) ? "checked" : ""} aria-label="${esc(m.name)}參與分攤">
      <span>${esc(m.name)}</span>
      <input inputmode="decimal" class="share-in" value="${esc(e.split_mode === "equal" ? "" : inputOf(m.id) ?? "")}">
      <span class="calc"></span></div>`).join("");

  openSheet(`<h2>${expense ? "編輯支出" : "記一筆"}</h2>
    <label class="field">項目<input id="exTitle" maxlength="80" placeholder="例如：一蘭拉麵" value="${esc(e.title)}"></label>
    <div class="row">
      <label class="field">金額<input id="exAmount" class="amount-input" inputmode="decimal" placeholder="0" value="${esc(expense ? Number(e.amount) : "")}"></label>
      <label class="field currency-select">幣別<select id="exCurrency">${currencies.map((c) =>
        `<option ${c === e.currency ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    </div>
    <div class="fx-line" id="fxLine" hidden>
      <span>1 <b id="fxFrom"></b> =</span><input id="fxRate" inputmode="decimal"><span>${esc(base)}</span>
      <span id="fxInfo"></span><button type="button" class="link" id="fxRefresh">重抓即時匯率</button>
    </div>
    <label class="field">誰付的${seg("paid", state.members.map((m) => [m.id, esc(m.name)]), e.paid_by)}</label>
    <label class="field">怎麼分${seg("split", Object.entries(SPLIT_LABEL), e.split_mode)}</label>
    <div class="panel" style="margin:0 0 14px">${shareRows}<div class="share-hint" id="shareHint"></div></div>
    <label class="field">分類${seg("cat", Object.entries(CATEGORY).map(([k, [i, n]]) => [k, `${i} ${n}`]), e.category)}</label>
    <label class="field">日期<input id="exDate" type="date" value="${esc(e.spent_on)}"></label>
    <label class="field">備註<textarea id="exNote" rows="2" maxlength="500">${esc(e.note)}</textarea></label>
    <div class="sheet-actions">
      ${expense ? `<button class="btn ghost danger" id="exDelete">刪除</button>` : ""}
      <button class="btn" id="exSave">儲存</button>
    </div>`, (root) => {
    let fxSource = e.fx_source === "same" ? "auto" : e.fx_source;
    let fxReq = 0;
    $("fxRate").value = e.currency !== base ? Number(e.fx_rate) : "";

    async function fetchRate() {
      const c = $("exCurrency").value;
      if (c === base) return;
      const my = ++fxReq;
      $("fxInfo").textContent = "查詢中…";
      try {
        const r = await api(`/api/fx?from=${c}&to=${base}`);
        if (my !== fxReq) return;
        $("fxRate").value = Number(r.rate);
        fxSource = "auto";
        $("fxInfo").textContent = "即時匯率";
      } catch (err) {
        if (my !== fxReq) return;
        fxSource = "manual";
        $("fxInfo").textContent = "查不到，請手動輸入";
        $("fxRate").focus();
      }
      update();
    }

    function currentWeights() {
      const mode = segValue(root, "split");
      const w = {};
      root.querySelectorAll(".share-row").forEach((row) => {
        const uid = row.dataset.uid;
        if (mode === "equal") { if (row.querySelector("input[type=checkbox]").checked) w[uid] = 1; }
        else { const v = num(row.querySelector(".share-in").value); if (v > 0) w[uid] = v; }
      });
      return w;
    }

    function update() {
      const c = $("exCurrency").value;
      const mode = segValue(root, "split");
      const foreign = c !== base;
      $("fxLine").hidden = !foreign;
      $("fxFrom").textContent = c;
      root.querySelectorAll(".share-row").forEach((row) => {
        row.querySelector("input[type=checkbox]").hidden = mode !== "equal";
        const inp = row.querySelector(".share-in");
        inp.hidden = mode === "equal";
        inp.placeholder = mode === "amount" ? "金額" : "比例";
      });
      const amount = num($("exAmount").value) || 0;
      const rate = foreign ? num($("fxRate").value) : 1;
      const baseAmount = Number.isFinite(rate) ? Math.round(amount * rate * 10 ** decimals(base)) / 10 ** decimals(base) : 0;
      const w = currentWeights();
      const paid = Number(segValue(root, "paid"));
      const shares = allocate(baseAmount, w, base, paid);
      root.querySelectorAll(".share-row").forEach((row) => {
        const v = shares[row.dataset.uid];
        row.querySelector(".calc").textContent = v != null && amount ? fmt(v, base) : "";
      });
      let hint = foreign && amount ? `換算約 ${fmt(baseAmount, base)}` : "";
      if (mode === "amount") {
        const sum = Object.values(w).reduce((s, v) => s + v, 0);
        const diff = Math.round((amount - sum) * 100) / 100;
        if (diff) hint += `${hint ? "，" : ""}<span class="owe">${diff > 0 ? "還差" : "多了"} ${fmt(Math.abs(diff), c)}</span>`;
      }
      $("shareHint").innerHTML = hint;
    }

    bindSeg(root, (name, v) => {
      if (name === "split" && v !== "equal") {
        // 從均分切到其他方式時，先幫忙填好均分的數字，改起來比較快
        const amount = num($("exAmount").value) || 0;
        const rows = [...root.querySelectorAll(".share-row")];
        rows.forEach((row) => {
          const inp = row.querySelector(".share-in");
          if (inp.value) return;
          if (v === "ratio") inp.value = "1";
          else if (amount) inp.value = String(allocate(amount, Object.fromEntries(rows.map((r) => [r.dataset.uid, 1])), $("exCurrency").value, Number(segValue(root, "paid")))[row.dataset.uid]);
        });
      }
      update();
    });
    root.addEventListener("input", (ev) => {
      if (ev.target.id === "fxRate") { fxSource = "manual"; $("fxInfo").textContent = "手動匯率"; }
      update();
    });
    $("exCurrency").addEventListener("change", () => { $("fxRate").value = ""; fetchRate(); });
    $("fxRefresh").addEventListener("click", fetchRate);
    if (e.currency !== base) $("fxInfo").textContent = fxSource === "manual" ? "手動匯率" : "存檔時的匯率";
    update();
    if (!expense) setTimeout(() => $("exTitle").focus(), 150);

    $("exSave").addEventListener("click", () => submitting($("exSave"), async () => {
      const mode = segValue(root, "split");
      const shares = {};
      root.querySelectorAll(".share-row").forEach((row) => {
        if (mode === "equal") { if (row.querySelector("input[type=checkbox]").checked) shares[row.dataset.uid] = "1"; }
        else shares[row.dataset.uid] = row.querySelector(".share-in").value || "0";
      });
      const c = $("exCurrency").value;
      const body = {
        title: $("exTitle").value, amount: $("exAmount").value, currency: c,
        paid_by: Number(segValue(root, "paid")), split_mode: mode, shares,
        category: segValue(root, "cat"), spent_on: $("exDate").value, note: $("exNote").value,
      };
      if (c !== base) { body.fx_rate = $("fxRate").value; body.fx_source = fxSource; }
      if (expense) await api(`/api/expenses/${expense.id}`, { method: "PUT", body });
      else await api(`/api/groups/${g.id}/expenses`, { method: "POST", body });
      closeSheet();
      toast(expense ? "已更新" : "記好了 🐷");
      await loadGroup(g.id); renderGroup();
    }));
    if (expense) $("exDelete").addEventListener("click", () => submitting($("exDelete"), async () => {
      if (!confirm(`確定刪除「${expense.title}」？`)) return;
      await api(`/api/expenses/${expense.id}`, { method: "DELETE" });
      closeSheet(); toast("已刪除");
      await loadGroup(g.id); renderGroup();
    }));
  });
}

// ---- 還款 ----

function openSettlement(prefill) {
  const g = state.detail.group;
  const cur = g.base_currency;
  const from = prefill?.from ?? state.me.id;
  const to = prefill?.to ?? (partner()?.id ?? state.me.id);
  openSheet(`<h2>記一筆還款</h2>
    <label class="field">誰還錢${seg("from", state.members.map((m) => [m.id, esc(m.name)]), from)}</label>
    <label class="field">還給誰${seg("to", state.members.map((m) => [m.id, esc(m.name)]), to)}</label>
    <label class="field">金額（${esc(cur)}）<input id="stAmount" class="amount-input" inputmode="decimal" value="${esc(prefill?.amount ? Number(prefill.amount) : "")}"></label>
    <label class="field">付款方式<div id="stMethods"></div><input id="stMethod" maxlength="60" placeholder="例如：現金、LINE Pay"></label>
    <label class="field">日期<input id="stDate" type="date" value="${todayISO()}"></label>
    <label class="field">備註<input id="stNote" maxlength="500"></label>
    <div class="sheet-actions"><button class="btn" id="stSave">記下來</button></div>`, (root) => {
    function methods() {
      const toId = Number(segValue(root, "to"));
      const list = ["現金", ...state.methods.filter((m) => m.user_id === toId).map((m) => m.label)];
      $("stMethods").innerHTML = `<div class="seg">${list.map((l) => `<button type="button" data-m="${esc(l)}">${esc(l)}</button>`).join("")}</div>`;
    }
    bindSeg(root, (name) => { if (name === "to") methods(); });
    root.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-m]"); if (!b) return;
      $("stMethod").value = b.dataset.m;
      $("stMethods").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    });
    methods();
    $("stSave").addEventListener("click", () => submitting($("stSave"), async () => {
      await api(`/api/groups/${g.id}/settlements`, { method: "POST", body: {
        from_user: Number(segValue(root, "from")), to_user: Number(segValue(root, "to")),
        amount: $("stAmount").value, method: $("stMethod").value, settled_on: $("stDate").value, note: $("stNote").value,
      } });
      closeSheet(); toast("已記下還款 💸");
      await loadGroup(g.id); renderGroup();
    }));
  });
}

function openSettlementDetail(s) {
  const cur = state.detail.group.base_currency;
  openSheet(`<h2>還款紀錄</h2>
    <div class="panel" style="margin:0 0 14px">
      <div class="headline">${esc(memberName(s.from_user))} → ${esc(memberName(s.to_user))}　${fmt(s.amount, cur)}</div>
      <div class="muted small">${esc(s.settled_on)}${s.method ? " · " + esc(s.method) : ""}</div>
      ${s.note ? `<p>${esc(s.note)}</p>` : ""}
    </div>
    <div class="sheet-actions"><button class="btn ghost danger" id="stDelete">刪除這筆還款</button></div>`, () => {
    $("stDelete").addEventListener("click", () => submitting($("stDelete"), async () => {
      if (!confirm("確定刪除這筆還款？")) return;
      await api(`/api/settlements/${s.id}`, { method: "DELETE" });
      closeSheet(); toast("已刪除");
      await loadGroup(s.group_id); renderGroup();
    }));
  });
}

// ---- 群組 ----

function openGroupForm(group) {
  const g = group || { name: "", emoji: "🐷", base_currency: "TWD", archived: false };
  const hasEntries = group && state.detail && (state.detail.expenses.length || state.detail.settlements.length);
  openSheet(`<h2>${group ? "群組設定" : "新群組"}</h2>
    <label class="field">名稱<input id="grName" maxlength="60" placeholder="例如：日常開銷、東京五天四夜" value="${esc(g.name)}"></label>
    <label class="field">圖示<div class="emoji-pick">${GROUP_EMOJIS.map((x) =>
      `<button type="button" data-emoji="${x}" class="${x === g.emoji ? "on" : ""}">${x}</button>`).join("")}</div></label>
    <label class="field">結算幣別<select id="grCurrency" ${hasEntries ? "disabled" : ""}>${CURRENCIES.map((c) =>
      `<option ${c === g.base_currency ? "selected" : ""}>${c}</option>`).join("")}</select></label>
    <p class="muted small">${hasEntries ? "群組已經有帳，結算幣別不能再改。" : "餘額用這個幣別計算。出國也建議維持 TWD，外幣支出會自動換算。"}</p>
    ${group ? `<label class="field"><span class="row" style="justify-content:flex-start;gap:10px">
      <input id="grArchived" type="checkbox" style="width:20px;height:20px;flex:none;margin:0" ${g.archived ? "checked" : ""}> 封存這個群組（帳都會保留）</span></label>` : ""}
    <div class="sheet-actions"><button class="btn" id="grSave">${group ? "儲存" : "建立"}</button></div>`, (root) => {
    let emoji = g.emoji;
    root.querySelectorAll("[data-emoji]").forEach((b) => b.addEventListener("click", () => {
      emoji = b.dataset.emoji;
      root.querySelectorAll("[data-emoji]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    if (!group) setTimeout(() => $("grName").focus(), 150);
    $("grSave").addEventListener("click", () => submitting($("grSave"), async () => {
      const body = { name: $("grName").value, emoji, base_currency: $("grCurrency").value, archived: group ? $("grArchived").checked : false };
      if (group) {
        const updated = await api(`/api/groups/${group.id}`, { method: "PUT", body });
        state.detail.group = updated;
        closeSheet(); renderGroup(); toast("已更新");
      } else {
        const created = await api("/api/groups", { method: "POST", body });
        closeSheet();
        location.hash = `#/g/${created.id}`;
      }
    }));
  });
}

// ===== 設定 =====

function renderSettings() {
  if (!state.me) return;
  $("myName").value = state.me.name;
  $("myEmail").textContent = `登入帳號：${state.me.email}`;
  const mine = state.methods.filter((m) => m.user_id === state.me.id);
  const p = partner();
  const theirs = p ? state.methods.filter((m) => m.user_id === p.id) : [];
  const row = (m, editable) => `<div class="method"><div><b>${esc(m.label)}</b><div class="detail">${esc(m.detail)}</div></div>
    ${editable ? `<button class="btn small ghost" data-method="${m.id}">編輯</button>` : ""}</div>`;
  $("methodList").innerHTML = `<div class="owner">我的</div>${mine.length ? mine.map((m) => row(m, true)).join("") : `<p class="muted small pad">還沒有設定</p>`}
    ${p ? `<div class="owner">${esc(p.name)}的</div>${theirs.length ? theirs.map((m) => row(m, false)).join("") : `<p class="muted small pad">還沒有設定</p>`}` : ""}`;
}

function openMethodForm(method) {
  const m = method || { label: "", detail: "" };
  openSheet(`<h2>${method ? "編輯收款方式" : "新增收款方式"}</h2>
    <label class="field">名稱<input id="pmLabel" maxlength="40" placeholder="例如：LINE Pay、國泰世華" value="${esc(m.label)}"></label>
    <label class="field">內容<textarea id="pmDetail" rows="3" maxlength="300" placeholder="帳號、ID 或備註">${esc(m.detail)}</textarea></label>
    <div class="sheet-actions">${method ? `<button class="btn ghost danger" id="pmDelete">刪除</button>` : ""}<button class="btn" id="pmSave">儲存</button></div>`, () => {
    $("pmSave").addEventListener("click", () => submitting($("pmSave"), async () => {
      const body = { label: $("pmLabel").value, detail: $("pmDetail").value };
      if (method) await api(`/api/payment-methods/${method.id}`, { method: "PUT", body });
      else await api("/api/payment-methods", { method: "POST", body });
      closeSheet(); await loadBootstrap(); renderSettings(); toast("已儲存");
    }));
    if (method) $("pmDelete").addEventListener("click", () => submitting($("pmDelete"), async () => {
      if (!confirm(`刪除「${method.label}」？`)) return;
      await api(`/api/payment-methods/${method.id}`, { method: "DELETE" });
      closeSheet(); await loadBootstrap(); renderSettings();
    }));
  });
}

// ===== 事件綁定 =====

document.addEventListener("click", (ev) => {
  const t = ev.target;
  const groupBtn = t.closest("[data-group]");
  if (groupBtn) { state.tab = "list"; location.hash = `#/g/${groupBtn.dataset.group}`; return; }
  const exBtn = t.closest("[data-expense]");
  if (exBtn) { openExpense(state.detail.expenses.find((e) => e.id === Number(exBtn.dataset.expense))); return; }
  const stBtn = t.closest("[data-settlement]");
  if (stBtn) { openSettlementDetail(state.detail.settlements.find((s) => s.id === Number(stBtn.dataset.settlement))); return; }
  const settle = t.closest("[data-settle]");
  if (settle) { const [from, to, amount] = settle.dataset.settle.split(","); openSettlement({ from: Number(from), to: Number(to), amount }); return; }
  const tab = t.closest(".tab");
  if (tab) { state.tab = tab.dataset.tab; renderGroup(); return; }
  const methodBtn = t.closest("[data-method]");
  if (methodBtn) { openMethodForm(state.methods.find((m) => m.id === Number(methodBtn.dataset.method))); return; }
  if (t.closest("[data-back]")) { location.hash = "#/"; }
});

$("backBtn").addEventListener("click", () => { location.hash = "#/"; });
$("settingsBtn").addEventListener("click", () => { location.hash = "#/settings"; });
$("newGroupBtn").addEventListener("click", () => openGroupForm(null));
$("groupSettingsBtn").addEventListener("click", () => state.detail && openGroupForm(state.detail.group));
$("addExpenseBtn").addEventListener("click", () => state.detail && openExpense(null));
$("newMethodBtn").addEventListener("click", () => openMethodForm(null));
$("logoutBtn").addEventListener("click", () => { if (confirm("確定登出？")) logout(); });
$("sheetBackdrop").addEventListener("click", closeSheet);
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("sheet").hidden) closeSheet(); });
$("saveNameBtn").addEventListener("click", () => submitting($("saveNameBtn"), async () => {
  const me = await api("/api/me", { method: "PUT", body: { name: $("myName").value } });
  state.me.name = me.name;
  await loadBootstrap(); renderSettings(); toast("暱稱已更新");
}));
window.addEventListener("hashchange", () => { closeSheet(); route(); });

// ===== 啟動 =====

(function boot() {
  // 頁面開啟時預熱：先叫醒 Render，使用者看畫面、按按鈕的同時它就在開機了。
  // 之後的 api() 會共用這個喚醒流程，不會重複打。
  ensureAwake().catch(() => {});

  const cached = store.json(BOOT_KEY);
  if (store.get(TOKEN_KEY) && cached) applyBootstrap(cached);
  route();

  if ("serviceWorker" in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
