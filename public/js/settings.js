// 設定頁：讀寫 /api/settings（存在 D1，各裝置共用）。
import { $, DEFAULT_SETTINGS, SHARE_FIELDS, api, bindLogout, esc, formatBytes, mergeSettings, setStatus } from "./common.js";

const form = $("#settings-form");
const status = $("#settings-status");

function fill(s) {
  $("#nickname").value = s.nickname;
  $("#default-hearts").value = String(s.defaultHearts);
  $("#ratings-default-on").checked = s.ratingsDefaultOn;
  for (const [k] of SHARE_FIELDS) $(`#def-share-${k}`).checked = Boolean(s.shareFields[k]);
  const pos = form.querySelector(`input[name="def-position"][value="${s.sharePosition}"]`);
  if (pos) pos.checked = true;
  $("#max-edge").value = String(s.maxEdge);
  const q = $("#quality");
  q.value = String(s.quality);
  const out = q.closest(".range")?.querySelector("output");
  if (out) out.value = q.value;
}

function read() {
  return {
    nickname: $("#nickname").value.trim(),
    defaultHearts: Number($("#default-hearts").value),
    ratingsDefaultOn: $("#ratings-default-on").checked,
    shareFields: Object.fromEntries(SHARE_FIELDS.map(([k]) => [k, $(`#def-share-${k}`).checked])),
    sharePosition: form.querySelector('input[name="def-position"]:checked')?.value || "bottom",
    maxEdge: Number($("#max-edge").value),
    quality: Number($("#quality").value),
  };
}

// 自動儲存：01–03 卡片的欄位一變動就排程寫入 D1，沒有儲存按鈕。降低寫入頻率的做法：
// - 防抖：選項類 change 等 AUTOSAVE_MS、稱呼打字等 TYPING_MS，期間的連續變動合併成一次
// - 滑桿只聽 change（放開才算），不聽拖曳中的 input；注音選字中（isComposing）不排程
// - 送出當下才讀表單，內容跟上次存成功的一樣就不送（切過去又切回來 = 0 次寫入）
// - 同時只送一個請求，送出期間的新變動等它回來再排一次
// - 切走分頁或離開頁面時，未存的變動用 keepalive 立刻送出
const AUTOSAVE_MS = 600;
const TYPING_MS = 1200;
const SAVED_TEXT = "已儲存設定，新增點評與分享頁會套用";
const nickname = $("#nickname");
const resetBtn = $("#reset-btn");
const scopes = ["#people-title", "#share-title", "#photo-title"].map((s) => $(s).closest("section"));
let ready = false; // 載入成功前不自動儲存，避免用預設值覆寫 D1 裡的設定
let lastSaved = "";
let inFlight = "";
let timer = 0;

const snapshot = () => JSON.stringify(read());
const isDirty = () => snapshot() !== lastSaved;

function schedule(ms) {
  clearTimeout(timer);
  if (!ready) return;
  if (!isDirty()) {
    if (!inFlight) setStatus(status, "");
    return;
  }
  setStatus(status, "有變更，稍後自動儲存…");
  timer = setTimeout(flush, ms);
}

async function flush({ keepalive = false } = {}) {
  clearTimeout(timer);
  if (!ready || !isDirty()) return;
  const body = snapshot();
  if (inFlight && (!keepalive || body === inFlight)) return; // 回來後會再檢查一次
  inFlight = body;
  setStatus(status, "儲存中…");
  try {
    const data = await api("/api/settings", { method: "PUT", json: JSON.parse(body), keepalive });
    lastSaved = body;
    if (!isDirty()) {
      const typing = document.activeElement === nickname ? nickname.value : null;
      fill(data.settings); // 套用伺服器正規化後的值
      if (typing !== null) nickname.value = typing; // 不打斷正在輸入的稱呼
      lastSaved = snapshot();
    }
  } catch (err) {
    setStatus(status, `${err.message}（下次變更時會再試）`, "error");
    return;
  } finally {
    if (inFlight === body) inFlight = "";
  }
  if (isDirty()) schedule(AUTOSAVE_MS);
  else setStatus(status, SAVED_TEXT, "ok");
}

for (const sec of scopes) {
  sec.addEventListener("change", () => schedule(AUTOSAVE_MS));
  sec.addEventListener("input", (e) => {
    if (e.target === nickname && !e.isComposing) schedule(TYPING_MS);
  });
}
nickname.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  flush();
});
// 表單裡已沒有送出按鈕；通行金鑰與密碼欄各自攔 Enter，這裡只擋掉預設送出
form.addEventListener("submit", (e) => e.preventDefault());

const saveOnLeave = () => {
  if (document.visibilityState === "hidden") flush({ keepalive: true });
};
document.addEventListener("visibilitychange", saveOnLeave);
addEventListener("pagehide", () => flush({ keepalive: true }));

resetBtn.addEventListener("click", () => {
  if (!confirm("恢復預設會立即覆寫目前的設定（含稱呼），確定嗎？")) return;
  fill(structuredClone(DEFAULT_SETTINGS));
  schedule(0);
});

bindLogout();
form.inert = true; // 載入前鎖住，避免先改的值被載入結果蓋掉
setStatus(status, "載入設定中…");
try {
  fill(mergeSettings((await api("/api/settings")).settings));
  lastSaved = snapshot();
  ready = true;
  setStatus(status, "");
} catch (err) {
  for (const sec of scopes) sec.inert = true;
  resetBtn.disabled = true;
  setStatus(status, `${err.message}；重新整理後再改設定`, "error");
}
form.inert = false;

// 通行金鑰（ADR 012–013）：新增、刪除、密碼登入開關都直接打 API，不經「儲存設定」。
const wa = window.SimpleWebAuthnBrowser;
const keyName = $("#passkey-name");
const addBtn = $("#add-passkey-btn");
const keyStatus = $("#passkey-status");
const keyList = $("#passkey-list");
const pwSwitch = $("#password-login");
const pwStatus = $("#password-login-status");

function when(iso) {
  return iso ? new Date(iso).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" }) : "尚未使用";
}

async function loadKeys() {
  const data = await api("/api/passkeys");
  keyList.innerHTML = data.passkeys
    .map(
      (k) => `<li class="app-key">
  <div class="app-key-body"><strong>${esc(k.name)}</strong>
  <span class="app-key-meta">新增於 ${esc(when(k.createdAt))} · 最後登入：${esc(when(k.lastUsedAt))}${k.backedUp ? " · 已同步備份" : ""}</span></div>
  <button class="btn is-sm secondary" type="button" data-del="${esc(k.id)}" data-name="${esc(k.name)}">刪除</button>
</li>`,
    )
    .join("");
  pwSwitch.checked = data.passwordLogin;
  pwSwitch.disabled = data.passwordLogin && data.passkeys.length === 0;
  if (!data.passkeys.length) setStatus(keyStatus, "還沒有通行金鑰，目前只能用密碼登入");
  return data;
}

addBtn.addEventListener("click", async () => {
  if (!wa?.browserSupportsWebAuthn()) {
    setStatus(keyStatus, "這個瀏覽器不支援通行金鑰，請換用新版 Safari、Chrome 或 Edge", "error");
    return;
  }
  const name = keyName.value.trim() || "通行金鑰";
  addBtn.disabled = true;
  setStatus(keyStatus, "請在裝置上完成驗證…");
  try {
    const optionsJSON = await api("/api/passkeys/register/options", { method: "POST", json: {} });
    const response = await wa.startRegistration({ optionsJSON });
    await api("/api/passkeys/register/verify", { method: "POST", json: { response, name } });
    keyName.value = "";
    await loadKeys();
    setStatus(keyStatus, `已新增「${name}」，登入頁可以用通行金鑰登入`, "ok");
  } catch (err) {
    const msg = err.name === "InvalidStateError" ? "這台裝置已經有這個網站的通行金鑰" : err.name === "NotAllowedError" ? "已取消或逾時，請再按一次" : err.message;
    setStatus(keyStatus, msg, "error");
  } finally {
    addBtn.disabled = false;
  }
});

// 名稱欄在 settings-form 裡，按 Enter 改成新增金鑰，不送出設定
keyName.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  addBtn.click();
});

keyList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-del]");
  if (!btn) return;
  if (!confirm(`刪除「${btn.dataset.name}」？刪除後這把金鑰不能再登入，裝置上的金鑰請到系統設定另外移除。`)) return;
  btn.disabled = true;
  try {
    await api(`/api/passkeys/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
    await loadKeys();
    setStatus(keyStatus, `已刪除「${btn.dataset.name}」`, "ok");
  } catch (err) {
    btn.disabled = false;
    setStatus(keyStatus, err.message, "error");
  }
});

pwSwitch.addEventListener("change", async () => {
  const enabled = pwSwitch.checked;
  if (!enabled && !confirm("關閉後登入頁只剩通行金鑰。確定要停用密碼登入？")) {
    pwSwitch.checked = true;
    return;
  }
  pwSwitch.disabled = true;
  try {
    await api("/api/auth/password-login", { method: "PUT", json: { enabled } });
    setStatus(pwStatus, enabled ? "已允許密碼登入" : "已停用密碼登入，之後請用通行金鑰登入", "ok");
  } catch (err) {
    pwSwitch.checked = !enabled;
    setStatus(pwStatus, err.message, "error");
  } finally {
    pwSwitch.disabled = false;
  }
});

try {
  await loadKeys();
} catch (err) {
  setStatus(keyStatus, err.message, "error");
}

// 帳號與密碼（ADR 018）：直接打 API，不經「儲存設定」。改完後這台換發新 cookie，其他裝置要重新登入。
const pwFields = ["#current-password", "#new-password", "#confirm-password"].map((s) => $(s));
const [curPw, newPw, confirmPw] = pwFields;
const changeBtn = $("#change-pw-btn");
const accountStatus = $("#account-status");

changeBtn.addEventListener("click", async () => {
  if (!curPw.value) {
    setStatus(accountStatus, "請輸入目前的密碼", "error");
    curPw.focus();
    return;
  }
  if ([...newPw.value].length < 8) {
    setStatus(accountStatus, "新密碼至少要 8 個字", "error");
    newPw.focus();
    return;
  }
  if (newPw.value !== confirmPw.value) {
    setStatus(accountStatus, "兩次輸入的新密碼不一樣", "error");
    confirmPw.select();
    return;
  }
  changeBtn.disabled = true;
  setStatus(accountStatus, "修改中…");
  try {
    await api("/api/account/password", { method: "PUT", json: { currentPassword: curPw.value, newPassword: newPw.value } });
    for (const f of pwFields) f.value = "";
    setStatus(accountStatus, "已修改密碼，其他裝置要用新密碼重新登入", "ok");
  } catch (err) {
    setStatus(accountStatus, err.message, "error");
  } finally {
    changeBtn.disabled = false;
  }
});

// 密碼欄在 settings-form 裡，按 Enter 改成修改密碼，不送出設定
for (const f of pwFields) {
  f.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    changeBtn.click();
  });
}

try {
  const me = await api("/api/account");
  $("#account-username").value = me.username;
} catch (err) {
  setStatus(accountStatus, err.message, "error");
}

// 用量清單（src/storage.js 快取值）：dd 依序是 D1 空間、R2 空間、D1 讀取列、D1 寫入列、Worker 請求數（build_pages.py 的 usage_block）。
// 讀寫列數與請求數是帳號合計、UTC 當日，對應免費方案的每日額度；沒設定 CF_ACCOUNT_ID／CF_ANALYTICS_TOKEN 時顯示「—」。
const usageStatus = $("#usage-status");
try {
  const s = await api("/api/storage");
  const n = (v) => Number(v).toLocaleString("zh-TW");
  const u = s.usage;
  const values = [
    formatBytes(s.d1.usedBytes),
    `${formatBytes(s.r2.usedBytes)}（${s.r2.objects} 個檔案）`,
    u ? `${n(u.d1RowsRead)} 列` : "—",
    u ? `${n(u.d1RowsWritten)} 列` : "—",
    u ? `${n(u.workerRequests)} 次` : "—",
  ];
  $("#usage-stats").querySelectorAll("dd").forEach((dd, i) => { dd.textContent = values[i]; });
  const time = new Date(s.updatedAt).toLocaleString("zh-TW", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const notes = [`更新於 ${time}${s.refreshing ? "，正在背景更新" : ""}`];
  notes.push(u ? `今日指 ${u.date}（UTC）` : "未設定 CF_ACCOUNT_ID／CF_ANALYTICS_TOKEN，不顯示讀寫次數");
  setStatus(usageStatus, notes.join("；"));
} catch (err) {
  setStatus(usageStatus, err.message, "error");
}
