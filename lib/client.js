window.__ModuleLoader__.load({ id: "dsh-keep-top", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
"use strict";
/**
 * dsh-keep-top —— 输出时跟到「本条回答的第一行」就停住
 *
 * 只做滚动落点，不碰官方展示档（transcriptView 保持 standard，过程行仍是官方的一行合并）。
 *
 * 核心做法（借鉴 dsh-streamfold 的写权思路，但只保留最小部分）：
 *   1. 官方自己在「贴底跟随」，我们不改它的跟随逻辑，只在合适的时机**接管写权**：
 *      一旦正文行到达视口顶部，就记下这个 scrollTop，之后每帧把它按住（rAF 循环 + scroll 事件纠偏）。
 *   2. 判据用「到达」而不是「穿越」：距离 <= gap 且没有越过太远。
 *      穿越判据在快速输出时会漏采样（一帧推几百像素），这就是之前「订不住」的原因。
 *   3. 任何用户输入立刻交还写权、本轮不再抢。
 *
 * 行契约（DSH 0.2.2 实测）：行 = [data-chat-flow-kind][data-chat-turn]；滚动容器 = [data-conversation-scroll]。
 */

const STORE = "dsh-keep-top";
const DEFAULTS = { enabled: true, topGap: 16, streamWindowMs: 2000, farPastPx: 400 };

function readSettings() {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return Object.assign({}, DEFAULTS);
    const obj = JSON.parse(raw);
    return Object.assign({}, DEFAULTS, obj && typeof obj === "object" ? obj : {});
  } catch (err) {
    return Object.assign({}, DEFAULTS);
  }
}
const settings = readSettings();

let container = null;
let observer = null;
let curTurn = null;
let pin = null;           // { turn, top } 写权被我们拿住时的目标 scrollTop
let releasedTurn = null;  // 本轮已交还写权（用户动过）
let releaseWhy = null;    // 交还写权的来源事件（排查用：wheel / pointerdown / key:PageDown …）
let ownWrite = false;
let rafId = 0;
let lastSig = null;
let lastNearBottomAt = 0;
let lastGrowthAt = 0;
let prevDistance = null;  // 上一帧正文顶到视口顶的距离，用于判「从下方靠近」
let bottomSince = 0;      // 连续贴底的起点时刻（0 = 当前没贴底）
let lastHref = "";
let trace = [];
let lastProseAt = 0;        // 最近一次认出正文行的时刻（自检用：DSH 改 DOM 后会一直是 0）
let proseMissingSince = 0;  // 从什么时候开始连续找不到正文行
let domWarned = false;      // 自检警告只打一次

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const scrollEl = () => document.querySelector("[data-conversation-scroll]");
const rowSel = "[data-chat-flow-kind][data-chat-turn]";
const turnOf = (row) => row.getAttribute("data-chat-turn");

function currentTurnRows(el) {
  const all = el.querySelectorAll(rowSel);
  if (all.length === 0) return [];
  const turn = turnOf(all[all.length - 1]);
  const out = [];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (turnOf(all[i]) !== turn) break;
    out.unshift(all[i]);
  }
  return out;
}

function isProse(row) {
  // 只认 assistant-step：turn-process（"已完成，用时 X 秒"）和 turn-tail（"用量 …"）都是一轮上下方的元信息行，
  // 它们本身是纯文本，很容易被误判成"正文第一行"——之前"输出完跳到已完成"就是这么来的。
  if (row.getAttribute("data-chat-flow-kind") !== "assistant-step") return false;
  if (row.querySelector("[data-tool]") !== null) return false;
  if (row.querySelector('[data-variant="think"]') !== null) return false;
  if (row.querySelector("[class*='_thinkBody']") !== null) return false;
  return (row.textContent || "").trim().length > 0;
}

function write(el, top) {
  ownWrite = true;
  try { el.scrollTop = top; } finally { ownWrite = false; }
}

/* 写权在手上时，每帧按正文行的**实际位置**纠偏（抢在官方下一次跟随写入之后、paint 之前）。
 * 不写死 pin.top：一轮结束时官方会在上方折过程行、插「已完成」，高度骤变，
 * 只补旧像素就会让视口相对正文漂移，表现为结束时抽一下。 */
function holdLoop() {
  rafId = 0;
  if (pin === null || !settings.enabled) return;
  const el = container;
  if (el !== null && el.isConnected) {
    const rows = currentTurnRows(el);
    let prose = null;
    for (const row of rows) {
      if (isProse(row)) { prose = row; break; }
    }
    if (prose !== null) {
      const distance = prose.getBoundingClientRect().top - el.getBoundingClientRect().top;
      const delta = distance - settings.topGap;
      if (Math.abs(delta) > 1) write(el, Math.max(0, el.scrollTop + delta));
      pin.top = el.scrollTop;
    } else if (Math.abs(el.scrollTop - pin.top) > 0.5) {
      write(el, pin.top);
    }
  }
  rafId = requestAnimationFrame(holdLoop);
}
function startHold() { if (rafId === 0) rafId = requestAnimationFrame(holdLoop); }
function stopHold() { if (rafId !== 0) { cancelAnimationFrame(rafId); rafId = 0; } }

function unpin(turn, why) {
  if (pin !== null) {
    releasedTurn = turn === undefined ? pin.turn : turn;
    releaseWhy = why === undefined ? "unknown" : why;
    pin = null;
  }
  stopHold();
}

function reset() {
  curTurn = null;
  pin = null;
  releasedTurn = null;
  releaseWhy = null;
  lastSig = null;
  lastGrowthAt = 0;
  lastNearBottomAt = 0;
  prevDistance = null;
  bottomSince = 0;
  lastProseAt = 0;
  proseMissingSince = 0;
}

function record(sample) {
  trace.push(sample);
  if (trace.length > 400) trace.splice(0, trace.length - 400);
}

function tick() {
  if (!settings.enabled) { record({ t: Math.round(nowMs()), reason: "disabled" }); return; }
  const el = container;
  if (el === null || !el.isConnected) { record({ t: Math.round(nowMs()), reason: "nocontainer" }); return; }

  // 切会话：SPA 里容器可能原样复用，靠 URL 变化兜底清状态
  if (location.href !== lastHref) {
    lastHref = location.href;
    reset();
  }

  const rows = currentTurnRows(el);
  if (rows.length === 0) { record({ t: Math.round(nowMs()), reason: "norows" }); return; }
  const turn = turnOf(rows[0]);
  if (turn !== curTurn) {
    curTurn = turn;
    pin = null;
    releasedTurn = null;
    releaseWhy = null;
    lastSig = null;
    stopHold();
  }

  // 内容增长信号
  const sig = rows.length + ":" + (rows[rows.length - 1].textContent || "").length;
  const now = nowMs();
  if (lastSig === null) {
    // 刚 reset 过（切会话回来、换轮）：这一帧只当基线，不算「内容在长」。
    // 否则历史行一次性渲染会被误判成正在输出，接着就把视口钉在本轮正文顶上。
    lastSig = sig;
    lastGrowthAt = 0;
  } else if (sig !== lastSig) {
    lastSig = sig;
    lastGrowthAt = now;
  }

  let prose = null;
  for (const row of rows) {
    if (isProse(row)) { prose = row; break; }
  }
  if (prose === null) {
    // 自检：内容明明还在长，却连续 5 秒认不出「正文行」，多半是上游改了 DOM 契约。
    // 插件在这种情况下会静默失效（界面看起来完全正常），所以至少让 Console 里留下一条线索。
    if (proseMissingSince === 0) proseMissingSince = now;
    const growing = now - lastGrowthAt < settings.streamWindowMs;
    if (!domWarned && growing && now - proseMissingSince > 5000) {
      domWarned = true;
      try {
        console.warn(
          "[dsh-keep-top] 已连续 5 秒找不到正文行（assistant-step），可能 DSH 改了 DOM 契约，插件没有接管滚动。" +
            " 用 __dshKeepTop.state() 看 lastProseAgo / trace() 看每帧 reason。",
          { turn, kinds: rows.map((r) => r.getAttribute("data-chat-flow-kind")).join("|") },
        );
      } catch (err) {}
    }
    record({ t: Math.round(now), reason: "noprose", turn, kinds: rows.map((r) => r.getAttribute("data-chat-flow-kind")).join("|") });
    return;
  }
  lastProseAt = now;
  proseMissingSince = 0;

  const distance = prose.getBoundingClientRect().top - el.getBoundingClientRect().top;
  const prev = prevDistance;
  prevDistance = distance;
  const scrollTop = el.scrollTop;
  const gapBottom = el.scrollHeight - el.clientHeight - scrollTop;
  if (gapBottom <= 64) {
    lastNearBottomAt = now;
    if (bottomSince === 0) bottomSince = now;
  } else {
    bottomSince = 0;
  }

  const streaming = now - lastGrowthAt < settings.streamWindowMs;
  const following = lastNearBottomAt !== 0 && now - lastNearBottomAt <= 600;
  // 连续贴底够久，才认定官方自己在跟随（切会话回来时是「恢复位置」，不算）
  const settled = bottomSince !== 0 && now - bottomSince >= 250;

  record({
    t: Math.round(now),
    turn,
    distance: Math.round(distance),
    scrollTop: Math.round(scrollTop),
    sh: el.scrollHeight,
    ch: el.clientHeight,
    gapBottom: Math.round(gapBottom),
    streaming,
    following,
    pinned: pin !== null,
    released: releasedTurn,
    why: releaseWhy,
  });

  if (pin !== null) {
    // 按住期间：以正文行的**实际位置**为准更新目标。
    // 一轮结束时官方会把上方过程行折叠成一行（高度骤减），锚死像素会把视口带跑，锚元素才稳。
    const delta = distance - settings.topGap;
    if (Math.abs(delta) > 1) {
      pin.top = Math.max(0, scrollTop + delta);
      write(el, pin.top);
    } else {
      pin.top = scrollTop;
    }
    return;
  }

  if (releasedTurn === turn) return;
  if (!streaming || !following || !settled) return;

  // 「到达」判据：正文顶已经在视口顶（或轻微越过），且没有越得太远（越太远说明早就过了，不该再抢）
  const reached = distance <= settings.topGap + 1;
  const notFarPast = distance > -(settings.topGap + settings.farPastPx);
  // 必须眼看它从下方靠近：上一帧还在视口顶下方。切会话回来时位置是直接恢复的，
  // 没有「靠近」这个过程，因此不会误触发。
  const arriving = prev !== null && prev > settings.topGap + 1;
  if (!reached || !notFarPast || !arriving) return;

  // 偏移不大就对齐到正文顶；已经过了不少就原地按住，不做大跨度回拉
  if (Math.abs(distance) <= 200) {
    const delta = distance - settings.topGap;
    if (Math.abs(delta) > 0.5) write(el, scrollTop + delta);
  }
  pin = { turn, top: el.scrollTop };
  startHold();
}

function onScroll() {
  if (ownWrite) return;
  tick();
}

function onUserInput(event) {
  const el = container;
  // 写权在手上时，用户自己滚动 ⇒ 立即交还，本轮不再抢
  if (pin !== null && el !== null) unpin(pin.turn, event && event.type ? event.type : "input");
}

function bind() {
  const el = scrollEl();
  if (el === container) return;
  if (container !== null) {
    container.removeEventListener("scroll", onScroll);
    container.removeEventListener("wheel", onUserInput, true);
    container.removeEventListener("touchstart", onUserInput, true);
    container.removeEventListener("touchmove", onUserInput, true);
    container.removeEventListener("pointerdown", onUserInput, true);
  }
  reset();
  container = el;
  if (el === null) return;
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("wheel", onUserInput, { passive: true, capture: true });
  el.addEventListener("touchstart", onUserInput, { passive: true, capture: true });
  el.addEventListener("touchmove", onUserInput, { passive: true, capture: true });
  el.addEventListener("pointerdown", onUserInput, { passive: true, capture: true });
  tick();
  startHold();
}

function start() {
  lastHref = location.href;
  bind();
  if (observer !== null) observer.disconnect();
  observer = new MutationObserver(() => {
    if (container === null || !container.isConnected) {
      const el = scrollEl();
      if (el !== container) bind();
    }
    tick();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function onKey(event) {
  if (pin === null) return;
  if (event.key === "PageUp" || event.key === "PageDown" || event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
    unpin(pin.turn, "key:" + event.key);
  }
}

/* 窗口尺寸变化（切全屏、拉边框）会让内容重排：正文顶的位置漂移，按住的目标要跟着重算 */
function onResize() { tick(); }

function dispose() {
  stopHold();
  if (observer !== null) { observer.disconnect(); observer = null; }
  if (container !== null) {
    container.removeEventListener("scroll", onScroll);
    container.removeEventListener("wheel", onUserInput, true);
    container.removeEventListener("touchstart", onUserInput, true);
    container.removeEventListener("touchmove", onUserInput, true);
    container.removeEventListener("pointerdown", onUserInput, true);
    container = null;
  }
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("resize", onResize);
}

function apply() {
  if (window.__dshKeepTop && typeof window.__dshKeepTop.dispose === "function") {
    try { window.__dshKeepTop.dispose(); } catch (err) {}
  }
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize, { passive: true });
  start();
  window.__dshKeepTop = {
    dispose,
    state: () => ({
      enabled: settings.enabled,
      turn: curTurn,
      frozen: pin !== null,
      gap: settings.topGap,
      released: releasedTurn,
      why: releaseWhy,
      streamingMsAgo: lastGrowthAt ? Math.round(nowMs() - lastGrowthAt) : null,
      nearBottomAgo: lastNearBottomAt ? Math.round(nowMs() - lastNearBottomAt) : null,
      lastProseAgo: lastProseAt ? Math.round(nowMs() - lastProseAt) : null,
      domWarned,
    }),
    trace: () => trace.slice(),
    dump: () => JSON.stringify(trace.slice()),
    clear: () => { trace = []; return trace.length; },
    set: (patch) => {
      if (!patch || typeof patch !== "object") return settings;
      if (typeof patch.enabled === "boolean") settings.enabled = patch.enabled;
      if (typeof patch.topGap === "number") settings.topGap = patch.topGap;
      if (typeof patch.streamWindowMs === "number") settings.streamWindowMs = patch.streamWindowMs;
      if (typeof patch.farPastPx === "number") settings.farPastPx = patch.farPastPx;
      try { localStorage.setItem(STORE, JSON.stringify({ enabled: settings.enabled, topGap: settings.topGap, streamWindowMs: settings.streamWindowMs, farPastPx: settings.farPastPx })); } catch (err) {}
      if (!settings.enabled) { pin = null; stopHold(); }
      return settings;
    },
  };
  return () => dispose();
}

exports.apply = apply;
exports.inject = [];
exports.defaults = DEFAULTS;
return module.exports; } });
