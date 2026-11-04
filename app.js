"use strict";

const API = "https://wild-mountain-bab7.pythonlyingpig.workers.dev";
const LEVEL_LABEL = { low: "低", mid: "中", high: "高" };
const ROW_H = 36;               // 規則列高度（要跟 CSS .rule 一致）
const MAX_SCROLL_H = 8_000_000; // 瀏覽器元素高度上限以下；規則太多時改用比例捲動

const $ = (id) => document.getElementById(id);
const fmtInt = (x) => x.toLocaleString("en-US");

let game = null;
let timerId = null;
let lastResult = null;

// ---------- 共用 ----------

function show(screen) {
  for (const s of ["screen-start", "screen-game", "screen-result"]) $(s).hidden = s !== screen;
}

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" };
  let res;
  try {
    res = await fetch(API + path, opt);
  } catch {
    throw Object.assign(new Error("連不上伺服器，請檢查網路後再試一次"), { status: 0 });
  }
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `伺服器錯誤（${res.status}）`), { status: res.status });
  return data;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function fmtElapsed(ms) {
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " 秒";
  return fmtTime(ms) + "." + Math.floor((ms % 1000) / 100);
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- 開始畫面 ----------

function initStart() {
  $("name").value = localStorage.getItem("sat-name") || "";
  const lv = localStorage.getItem("sat-level");
  if (lv && LEVEL_LABEL[lv]) document.querySelector(`input[name=level][value=${lv}]`).checked = true;
  $("btn-start").addEventListener("click", startGame);
  $("name").addEventListener("keydown", (e) => { if (e.key === "Enter") startGame(); });
}

async function startGame() {
  const name = $("name").value.trim();
  const picked = document.querySelector("input[name=level]:checked");
  $("start-error").textContent = "";
  if (!name) { $("start-error").textContent = "請輸入名字"; return; }
  if ([...name].length > 20) { $("start-error").textContent = "名字最多 20 個字"; return; }
  if (!picked) { $("start-error").textContent = "請選擇難度"; return; }
  localStorage.setItem("sat-name", name);
  localStorage.setItem("sat-level", picked.value);

  $("btn-start").disabled = true;
  $("btn-start").textContent = "出題中…";
  try {
    const p = await api("/start", { name, level: picked.value });
    await nextFrame();
    setupGame(p);
  } catch (e) {
    $("start-error").textContent = e.message;
  } finally {
    $("btn-start").disabled = false;
    $("btn-start").textContent = "確認，開始";
  }
}

// ---------- 遊戲 ----------

function setupGame(p) {
  const { n, m } = p;
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(m) || m < 1 ||
      !Array.isArray(p.rules) || p.rules.length !== m * 3 ||
      !p.rules.every((l) => Number.isInteger(l) && l !== 0 && Math.abs(l) <= n)) {
    throw new Error("題目格式錯誤");
  }
  const rules = Int32Array.from(p.rules);

  // 每個開關出現在哪些規則（CSR）
  const occStart = new Int32Array(n + 2);
  for (let i = 0; i < rules.length; i++) occStart[Math.abs(rules[i]) + 1]++;
  for (let v = 1; v <= n + 1; v++) occStart[v] += occStart[v - 1];
  const occ = new Int32Array(rules.length);
  const fill = occStart.slice();
  for (let i = 0; i < rules.length; i++) occ[fill[Math.abs(rules[i])]++] = (i / 3) | 0;

  game = {
    id: p.id, level: p.level, n, m, rules, occStart, occ,
    bits: new Uint8Array(n + 1),
    trueCount: new Uint8Array(m),
    badCount: new Int32Array(n + 1),
    passed: 0, selected: 0, filter: "all",
    list: null, listLen: m, listBuf: null,
    startedAt: performance.now(), submitting: false, prompt: null,
  };

  $("g-level").textContent = LEVEL_LABEL[p.level];
  $("g-size").textContent = `${fmtInt(n)} 個開關 · ${fmtInt(m)} 條規則`;
  $("g-total").textContent = fmtInt(m);
  $("answer").value = "";
  $("game-error").textContent = "";
  $("filter-sel").disabled = true;
  $("filter-sel").textContent = "選中的開關";
  $("screen-game").classList.remove("size-low", "size-mid", "size-high");
  $("screen-game").classList.add("size-" + p.level);

  clearInterval(timerId);
  const tick = () => { $("g-timer").textContent = fmtTime(performance.now() - game.startedAt); };
  tick();
  timerId = setInterval(tick, 1000);
  show("screen-game");

  buildSwitches();
  recomputeAll();
  setFilter("all");
  updateAnswerCount();
}

function litTrue(l) { return (l > 0) === (game.bits[Math.abs(l)] === 1); }

function recomputeAll() {
  const { rules, m } = game;
  game.passed = 0;
  game.badCount.fill(0);
  for (let r = 0; r < m; r++) {
    let t = 0;
    for (let j = 0; j < 3; j++) if (litTrue(rules[r * 3 + j])) t++;
    game.trueCount[r] = t;
    if (t) game.passed++;
    else for (let j = 0; j < 3; j++) game.badCount[Math.abs(rules[r * 3 + j])]++;
  }
  paintAllSwitches();
  updateStatus();
  refreshList();
}

function toggle(v) {
  const { rules, occ, occStart } = game;
  game.bits[v] ^= 1;
  const touched = new Set([v]);
  for (let x = occStart[v]; x < occStart[v + 1]; x++) {
    const r = occ[x];
    let lit = 0;
    for (let j = 0; j < 3; j++) if (Math.abs(rules[r * 3 + j]) === v) lit = rules[r * 3 + j];
    const before = game.trueCount[r];
    game.trueCount[r] += litTrue(lit) ? 1 : -1;
    const after = game.trueCount[r];
    if (!before && after) {
      game.passed++;
      for (let j = 0; j < 3; j++) { const w = Math.abs(rules[r * 3 + j]); game.badCount[w]--; touched.add(w); }
    } else if (before && !after) {
      game.passed--;
      for (let j = 0; j < 3; j++) { const w = Math.abs(rules[r * 3 + j]); game.badCount[w]++; touched.add(w); }
    }
  }
  for (const w of touched) paintSwitch(w);
  updateStatus();
  refreshList();
}

function updateStatus() {
  $("g-passed").textContent = fmtInt(game.passed);
  $("g-bar").style.width = (game.passed / game.m * 100) + "%";
}

// ---------- 開關：低 = 大撥桿（DOM），中/高 = canvas 格子 ----------

let swEls = [];
const grid = { cell: 18, pad: 12, cols: 1, rows: 1, drawQueued: false };

function buildSwitches() {
  const box = $("switches");
  box.textContent = "";
  swEls = [null];
  $("sw-scroll").scrollTop = 0;
  if (game.level === "low") {
    const frag = document.createDocumentFragment();
    for (let v = 1; v <= game.n; v++) {
      const el = document.createElement("div");
      el.className = "sw";
      el.dataset.v = v;
      for (const cls of ["num", "knob", "state"]) {
        const s = document.createElement("span");
        s.className = cls;
        el.appendChild(s);
      }
      el.querySelector(".num").textContent = v + " 號";
      swEls.push(el);
      frag.appendChild(el);
    }
    box.appendChild(frag);
    return;
  }
  grid.cell = game.level === "mid" ? 18 : 13;
  layoutGrid();
}

function layoutGrid() {
  if (!game || game.level === "low") return;
  const sc = $("sw-scroll");
  grid.cols = Math.max(1, Math.floor((sc.clientWidth - grid.pad * 2) / grid.cell));
  grid.rows = Math.ceil(game.n / grid.cols);
  $("sw-spacer").style.height = grid.rows * grid.cell + grid.pad * 2 + "px";
  const cv = $("sw-canvas"), dpr = window.devicePixelRatio || 1;
  cv.width = Math.floor(sc.clientWidth * dpr);
  cv.height = Math.floor(sc.clientHeight * dpr);
  cv.style.width = sc.clientWidth + "px";
  cv.style.height = sc.clientHeight + "px";
  drawGrid();
}

function requestDraw() {
  if (grid.drawQueued) return;
  grid.drawQueued = true;
  requestAnimationFrame(() => { grid.drawQueued = false; drawGrid(); });
}

function cellColor(v) {
  return game.bits[v] === 1 ? "#ffd23f" : "#39445f";
}

function drawGrid() {
  if (!game || game.level === "low") return;
  const sc = $("sw-scroll"), cv = $("sw-canvas"), ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1, st = sc.scrollTop, h = sc.clientHeight;
  const { cell, pad, cols } = grid, size = cell - (cell > 10 ? 3 : 1);
  cv.style.top = st + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const r0 = Math.max(0, Math.floor((st - pad) / cell));
  const r1 = Math.min(grid.rows, Math.ceil((st + h - pad) / cell));
  for (let r = r0; r < r1; r++) {
    const y = pad + r * cell - st;
    for (let c = 0; c < cols; c++) {
      const v = r * cols + c + 1;
      if (v > game.n) break;
      ctx.fillStyle = cellColor(v);
      ctx.fillRect(pad + c * cell, y, size, size);
    }
  }
  const s = game.selected;
  if (s) {
    const r = Math.floor((s - 1) / cols), c = (s - 1) % cols;
    const y = pad + r * cell - st;
    if (y > -cell && y < h) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.strokeRect(pad + c * cell - 2, y - 2, size + 4, size + 4);
    }
  }
}

function switchAt(e) {
  const cv = $("sw-canvas"), rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left - grid.pad, y = e.clientY - rect.top + $("sw-scroll").scrollTop - grid.pad;
  if (x < 0 || y < 0) return 0;
  const c = Math.floor(x / grid.cell), r = Math.floor(y / grid.cell);
  if (c >= grid.cols) return 0;
  const v = r * grid.cols + c + 1;
  return v >= 1 && v <= game.n ? v : 0;
}

function paintSwitch(v) {
  if (game.level !== "low") { requestDraw(); return; }
  const el = swEls[v], on = game.bits[v] === 1;
  el.classList.toggle("on", on);
  el.classList.toggle("bad", game.badCount[v] > 0);
  el.classList.toggle("sel", game.selected === v);
  el.querySelector(".state").textContent = on ? "開" : "關";
}

function paintAllSwitches() {
  if (game.level !== "low") { requestDraw(); return; }
  for (let v = 1; v <= game.n; v++) paintSwitch(v);
}

function selectSwitch(v, scroll) {
  const prev = game.selected;
  game.selected = v;
  if (prev) paintSwitch(prev);
  paintSwitch(v);
  $("filter-sel").disabled = false;
  $("filter-sel").textContent = `${fmtInt(v)} 號相關`;
  if (scroll) {
    if (game.level === "low") {
      swEls[v].classList.remove("flash");
      void swEls[v].offsetWidth;
      swEls[v].classList.add("flash");
    } else {
      const sc = $("sw-scroll"), y = grid.pad + Math.floor((v - 1) / grid.cols) * grid.cell;
      if (y < sc.scrollTop || y > sc.scrollTop + sc.clientHeight - grid.cell) sc.scrollTop = y - sc.clientHeight / 2;
      requestDraw();
    }
  }
  if (game.filter === "sel") setFilter("sel");
  else renderRules();
}

function hoverText(v) {
  const bad = game.badCount[v];
  return `${fmtInt(v)} 號：${game.bits[v] ? "開" : "關"}` + (bad ? `，有 ${fmtInt(bad)} 條沒過的規則用到它` : "");
}

function onSwitchClick(v) {
  toggle(v);
  selectSwitch(v, false);
  $("sw-hover").textContent = hoverText(v);
}

function initSwitchEvents() {
  const box = $("switches");
  box.addEventListener("click", (e) => {
    const el = e.target.closest(".sw");
    if (el && game) onSwitchClick(Number(el.dataset.v));
  });
  box.addEventListener("mouseover", (e) => {
    const el = e.target.closest(".sw");
    if (el && game) $("sw-hover").textContent = hoverText(Number(el.dataset.v));
  });
  const cv = $("sw-canvas");
  cv.addEventListener("click", (e) => {
    if (!game) return;
    const v = switchAt(e);
    if (v) onSwitchClick(v);
  });
  cv.addEventListener("mousemove", (e) => {
    if (!game) return;
    const v = switchAt(e);
    $("sw-hover").textContent = v ? hoverText(v) : "點一下切換開／關";
  });
  for (const el of [box, cv]) el.addEventListener("mouseleave", () => { $("sw-hover").textContent = "點一下切換開／關"; });
  $("sw-scroll").addEventListener("scroll", () => requestDraw());
  window.addEventListener("resize", () => { layoutGrid(); renderRules(); });
  $("sw-jump").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !game) return;
    const v = Number($("sw-jump").value);
    if (Number.isInteger(v) && v >= 1 && v <= game.n) selectSwitch(v, true);
  });
}

// ---------- 規則（虛擬捲動；規則超過瀏覽器高度上限時改用比例捲動） ----------

function setFilter(f) {
  game.filter = f;
  for (const b of $("rule-filter").querySelectorAll("button")) b.classList.toggle("on", b.dataset.f === f);
  $("rules-scroll").scrollTop = 0;
  refreshList();
}

function refreshList() {
  const { m, filter, selected } = game;
  if (filter === "fail") {
    if (!game.listBuf) game.listBuf = new Int32Array(m);
    let c = 0;
    for (let r = 0; r < m; r++) if (!game.trueCount[r]) game.listBuf[c++] = r;
    game.list = game.listBuf;
    game.listLen = c;
  } else if (filter === "sel" && selected) {
    game.list = game.occ.subarray(game.occStart[selected], game.occStart[selected + 1]);
    game.listLen = game.list.length;
  } else {
    game.list = null;
    game.listLen = m;
  }
  const count = game.listLen;
  $("rules-spacer").style.height = Math.min(count * ROW_H, MAX_SCROLL_H) + "px";
  let info;
  if (filter === "all") info = `共 ${fmtInt(m)} 條，還有 ${fmtInt(m - game.passed)} 條沒過`;
  else if (filter === "fail") info = count ? `沒過的規則 ${fmtInt(count)} 條` : "全部規則都過關了！";
  else info = `用到 ${fmtInt(selected)} 號的規則 ${count} 條`;
  $("rules-info").textContent = info;
  renderRules();
}

function scrollGeom() {
  const sc = $("rules-scroll");
  const total = game.listLen * ROW_H, H = Math.min(total, MAX_SCROLL_H), ch = sc.clientHeight;
  return { sc, total, H, ch, scaled: total > MAX_SCROLL_H };
}

function contentTop() {
  const { sc, total, H, ch, scaled } = scrollGeom();
  if (!scaled) return sc.scrollTop;
  const maxSt = Math.max(1, H - ch);
  return Math.min(sc.scrollTop, maxSt) / maxSt * Math.max(0, total - ch);
}

function scrollToIndex(i) {
  const { sc, total, H, ch, scaled } = scrollGeom();
  const target = i * ROW_H;
  sc.scrollTop = scaled ? target / Math.max(1, total - ch) * (H - ch) : target;
  renderRules();
}

function renderRules() {
  if (!game) return;
  const sc = $("rules-scroll"), spacer = $("rules-spacer");
  const count = game.listLen, ct = contentTop(), st = sc.scrollTop;
  const first = Math.max(0, Math.floor(ct / ROW_H) - 3);
  const last = Math.min(count, Math.ceil((ct + sc.clientHeight) / ROW_H) + 3);
  const frag = document.createDocumentFragment();
  for (let i = first; i < last; i++) {
    const r = game.list ? game.list[i] : i;
    const row = document.createElement("div");
    row.className = "rule" + (game.trueCount[r] ? " pass" : "");
    row.style.top = st + (i * ROW_H - ct) + "px";
    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = game.trueCount[r] ? "✔" : "✘";
    const id = document.createElement("span");
    id.className = "rid";
    id.textContent = "規則" + (r + 1);
    row.append(mark, id);
    let hl = false;
    for (let j = 0; j < 3; j++) {
      const l = game.rules[r * 3 + j], v = Math.abs(l);
      if (v === game.selected) hl = true;
      const chip = document.createElement("span");
      chip.className = "chip" + (litTrue(l) ? " ok" : "");
      chip.dataset.v = v;
      chip.textContent = v + (l > 0 ? "開" : "關");
      row.appendChild(chip);
    }
    if (hl) row.classList.add("hl");
    frag.appendChild(row);
  }
  spacer.textContent = "";
  spacer.appendChild(frag);
}

function initRuleEvents() {
  $("rules-scroll").addEventListener("scroll", () => requestAnimationFrame(renderRules));
  $("rule-filter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b && !b.disabled && game) setFilter(b.dataset.f);
  });
  $("rules-spacer").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip && game) selectSwitch(Number(chip.dataset.v), true);
  });
  $("rule-jump").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !game) return;
    const r = Number($("rule-jump").value);
    if (!Number.isInteger(r) || r < 1 || r > game.m) return;
    if (game.filter !== "all") setFilter("all");
    scrollToIndex(r - 1);
  });
}

// ---------- 匯出題目 ----------

function promptHeader() {
  const { n, m } = game;
  return [
    "請用3-SAT解法器，以最快的速度解開下面的問題。",
    "",
    `有 ${n} 個開關，編號 1～${n}，每個開關只能是「開」或「關」。`,
    `下面有 ${m} 條規則，每條規則列出三個條件，三個條件中只要有一個成立，這條規則就算過關。`,
    "請找出一組開法，讓所有規則同時過關。這題保證有解。",
    "",
    `回答格式：只輸出一行由 0 和 1 組成的字串，長度剛好 ${n} 個字元，中間不要有空白。`,
    "第 1 個字元代表 1 號開關，第 2 個字元代表 2 號開關，以此類推；1 = 開、0 = 關。",
    "例如有 5 個開關時，10110 代表：1開、2關、3開、4開、5關。",
    "",
    "",
  ].join("\n");
}

function ruleLines(from, to) {
  const out = [];
  for (let r = from; r < to; r++) {
    const a = game.rules[r * 3], b = game.rules[r * 3 + 1], c = game.rules[r * 3 + 2];
    out.push(`規則${r + 1}：${Math.abs(a)}${a > 0 ? "開" : "關"}、${Math.abs(b)}${b > 0 ? "開" : "關"}、${Math.abs(c)}${c > 0 ? "開" : "關"}`);
  }
  return out.join("\n") + "\n";
}

function openExport() {
  if (!game.prompt) game.prompt = promptHeader() + ruleLines(0, game.m);
  $("prompt").value = game.prompt;
  $("prompt").scrollTop = 0;
  $("copy-msg").textContent = "";
  $("modal").hidden = false;
}

function download() {
  if (!game.prompt) game.prompt = promptHeader() + ruleLines(0, game.m);
  const url = URL.createObjectURL(new Blob([game.prompt], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `開關機台_${LEVEL_LABEL[game.level]}_${game.id.slice(0, 8)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function initExport() {
  $("btn-export").addEventListener("click", () => game && openExport());
  $("modal-close").addEventListener("click", () => { $("modal").hidden = true; });
  $("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").hidden = true; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("modal").hidden = true; });
  $("btn-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(game.prompt);
      $("copy-msg").textContent = "已複製";
    } catch {
      $("prompt").select();
      $("copy-msg").textContent = "無法自動複製，已幫你全選，請按 Ctrl+C";
    }
  });
  $("btn-download").addEventListener("click", () => game && download());
}

// ---------- 貼上答案 ----------

function cleanAnswer() {
  return $("answer").value.replace(/\s+/g, "");
}

function checkAnswer(s) {
  if (!s) return "請先貼上答案";
  if (!/^[01]+$/.test(s)) return "答案只能有 0 和 1";
  if (s.length !== game.n) return `長度要剛好 ${fmtInt(game.n)} 個，現在是 ${fmtInt(s.length)} 個`;
  return null;
}

function updateAnswerCount() {
  const s = cleanAnswer();
  $("answer-count").textContent = s ? `${fmtInt(s.length)} / ${fmtInt(game.n)}` : "";
}

function initAnswer() {
  $("answer").addEventListener("input", () => game && updateAnswerCount());
  $("btn-apply").addEventListener("click", () => {
    if (!game) return;
    const s = cleanAnswer();
    const err = checkAnswer(s);
    $("game-error").textContent = err || "";
    if (err) return;
    for (let i = 0; i < game.n; i++) game.bits[i + 1] = s.charCodeAt(i) === 49 ? 1 : 0;
    recomputeAll();
  });
  $("btn-clear").addEventListener("click", () => {
    if (!game) return;
    game.bits.fill(0);
    recomputeAll();
  });
}

// ---------- 送出 ----------

function currentBits() {
  const out = new Uint8Array(game.n);
  for (let v = 1; v <= game.n; v++) out[v - 1] = game.bits[v] ? 49 : 48;
  return new TextDecoder().decode(out);
}

async function submit() {
  if (!game || game.submitting) return;
  const left = game.m - game.passed;
  const msg = left
    ? `還有 ${fmtInt(left)} 條規則沒過，送出後這一局就結束，確定要送出嗎？`
    : "全部規則都過關了！送出後這一局就結束，確定要送出嗎？";
  if (!confirm(msg)) return;

  game.submitting = true;
  $("btn-submit").disabled = true;
  $("btn-submit").textContent = "送出中…";
  $("game-error").textContent = "";
  const g = game;
  try {
    const res = await api("/submit", { id: g.id, bits: currentBits() });
    endGame(g, res);
  } catch (e) {
    if (e.status === 409 || e.status === 410) endGame(g, null, e.message);
    else $("game-error").textContent = e.message + "（答案還沒送出，可以再按一次）";
  } finally {
    g.submitting = false;
    $("btn-submit").disabled = false;
    $("btn-submit").textContent = "送出答案";
  }
}

function endGame(g, res, note) {
  clearInterval(timerId);
  game = null;
  $("modal").hidden = true;
  lastResult = res ? { level: g.level, rank: res.rank } : null;
  const t = $("r-title");
  if (!res) {
    t.textContent = "這一局已結束";
    t.className = "";
    $("r-detail").textContent = note || "";
  } else if (res.ok) {
    t.textContent = "🎉 過關成功！";
    t.className = "win";
    $("r-detail").textContent =
      `全部 ${fmtInt(g.m)} 條規則都過了，用時 ${fmtElapsed(res.elapsed_ms)}，排名第 ${res.rank} 名。`;
  } else {
    t.textContent = "挑戰失敗";
    t.className = "lose";
    $("r-detail").textContent =
      `過關 ${fmtInt(g.passed)} / ${fmtInt(g.m)} 條，還差 ${fmtInt(g.m - g.passed)} 條。用時 ${fmtElapsed(res.elapsed_ms)}。`;
  }
  show("screen-result");
  loadBoard(g.level);
}

// ---------- 排行榜 ----------

async function loadBoard(level) {
  for (const b of $("board-tabs").querySelectorAll("button")) b.classList.toggle("on", b.dataset.l === level);
  const body = $("board-body");
  body.textContent = "";
  const msgRow = (text) => {
    const tr = document.createElement("tr");
    tr.className = "empty";
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  };
  msgRow("載入中…");
  try {
    const data = await api("/leaderboard?level=" + level);
    body.textContent = "";
    if (!data.entries.length) { msgRow("還沒有人過關"); return; }
    data.entries.forEach((e, i) => {
      const tr = document.createElement("tr");
      if (lastResult && lastResult.level === level && lastResult.rank === i + 1) tr.className = "me";
      for (const text of [i + 1, e.name, fmtElapsed(e.elapsed_ms), new Date(e.submitted_at).toLocaleString("zh-TW")]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    });
  } catch (e) {
    body.textContent = "";
    msgRow("排行榜載入失敗：" + e.message);
  }
}

function initResult() {
  $("board-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) loadBoard(b.dataset.l);
  });
  $("btn-again").addEventListener("click", () => {
    lastResult = null;
    show("screen-start");
    $("name").focus();
  });
}

// ---------- 啟動 ----------

window.addEventListener("beforeunload", (e) => {
  if (game) { e.preventDefault(); e.returnValue = ""; }
});

// 被別的網站用 iframe 嵌入就不啟動
if (window.top !== window.self) {
  document.body.textContent = "請直接開啟本網站遊玩。";
} else {
  initStart();
  initSwitchEvents();
  initRuleEvents();
  initExport();
  initAnswer();
  initResult();
  $("btn-submit").addEventListener("click", submit);
}
