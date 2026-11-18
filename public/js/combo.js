// 可搜尋的下拉選單（Select2 風格，不依賴 jQuery）：把原生 <select> 換成按鈕＋彈出清單，清單上方有搜尋框。
// 原生 <select> 仍留在頁面上當資料來源與值的出口：外面照舊改 innerHTML、設 value、disabled、監聽 change，
// 這裡用 MutationObserver 與 value setter 跟著重畫；選了項目就設回 select.value 並觸發 change。
// 原生 select 只是視覺隱藏（1px），Playwright 的 select_option 仍能操作它。

let seq = 0;

const norm = (s) => s.normalize("NFKC").toLowerCase();

function highlight(text, q) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  if (!q) return esc(text);
  const i = norm(text).indexOf(q);
  // NFKC 可能改變長度（全形轉半形不會，但合字會）；長度對不上就不標，避免標錯位置
  if (i < 0 || norm(text).length !== text.length) return esc(text);
  return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
}

export function combo(select, { searchPlaceholder = "輸入關鍵字搜尋" } = {}) {
  const id = `combo-${++seq}`;
  const wrap = document.createElement("div");
  wrap.className = "app-combo";
  wrap.innerHTML = `<button class="app-combo-btn" type="button" id="${id}-btn" aria-haspopup="listbox" aria-expanded="false"><span class="app-combo-value"></span><span class="app-combo-arrow" aria-hidden="true"></span></button>
<div class="app-combo-pop" hidden>
  <input class="app-combo-search" type="search" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${id}-list" autocomplete="off" spellcheck="false" placeholder="${searchPlaceholder}">
  <ul class="app-combo-list" id="${id}-list" role="listbox"></ul>
  <p class="app-combo-empty" hidden>找不到符合的項目</p>
</div>`;
  select.after(wrap);
  wrap.prepend(select); // 搬進 wrap 裡，CSS 用 .app-combo > .app-combo-native 隱藏
  select.classList.add("app-combo-native");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const btn = wrap.querySelector(".app-combo-btn");
  const valueEl = wrap.querySelector(".app-combo-value");
  const pop = wrap.querySelector(".app-combo-pop");
  const search = wrap.querySelector(".app-combo-search");
  const list = wrap.querySelector(".app-combo-list");
  const empty = wrap.querySelector(".app-combo-empty");

  // 原本指向 select 的 <label for> 改指向按鈕：點標籤會聚焦按鈕，螢幕閱讀器也念得到欄位名
  const label = select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
  if (label) {
    label.htmlFor = btn.id;
    if (!label.id) label.id = `${id}-label`;
    list.setAttribute("aria-labelledby", label.id);
    search.setAttribute("aria-labelledby", label.id);
  }
  const hintId = select.getAttribute("aria-describedby");
  if (hintId) btn.setAttribute("aria-describedby", hintId);

  let shown = []; // 目前清單上的 option 索引
  let active = -1; // shown 裡的位置

  const isOpen = () => !pop.hidden;

  function syncButton() {
    const opt = select.options[select.selectedIndex];
    valueEl.textContent = opt ? opt.text : "";
    btn.disabled = select.disabled || select.options.length === 0;
    if (btn.disabled && isOpen()) close(false);
  }

  function setActive(i) {
    const items = list.children;
    if (items[active]) items[active].classList.remove("is-active");
    active = Math.max(-1, Math.min(i, shown.length - 1));
    const el = items[active];
    if (el) {
      el.classList.add("is-active");
      el.scrollIntoView({ block: "nearest" });
      search.setAttribute("aria-activedescendant", el.id);
    } else {
      search.removeAttribute("aria-activedescendant");
    }
  }

  function renderList() {
    const q = norm(search.value.trim());
    shown = [];
    for (const opt of select.options) {
      if (!opt.disabled && (!q || norm(opt.text).includes(q))) shown.push(opt.index);
    }
    list.innerHTML = shown
      .map((i) => {
        const opt = select.options[i];
        const sel = i === select.selectedIndex;
        return `<li class="app-combo-option" id="${id}-opt-${i}" role="option" aria-selected="${sel}" data-index="${i}">${highlight(opt.text, q)}</li>`;
      })
      .join("");
    empty.hidden = shown.length > 0;
    active = -1;
    const cur = shown.indexOf(select.selectedIndex);
    setActive(cur >= 0 ? cur : 0);
  }

  function open(initial = "") {
    if (btn.disabled || isOpen()) return;
    pop.hidden = false;
    wrap.classList.add("is-open");
    btn.setAttribute("aria-expanded", "true");
    search.value = initial;
    renderList();
    search.focus();
  }

  function close(focusBtn = true) {
    if (!isOpen()) return;
    pop.hidden = true;
    wrap.classList.remove("is-open");
    btn.setAttribute("aria-expanded", "false");
    search.removeAttribute("aria-activedescendant");
    if (focusBtn) btn.focus();
  }

  function choose(index) {
    const changed = index !== select.selectedIndex;
    select.selectedIndex = index;
    syncButton();
    close();
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  btn.addEventListener("click", () => (isOpen() ? close() : open()));
  btn.addEventListener("keydown", (e) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      open();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 聚焦在按鈕上直接打字：開啟並把字帶進搜尋框
      e.preventDefault();
      open(e.key);
    }
  });

  search.addEventListener("input", renderList);
  search.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // 注音、倉頡選字中的 Enter／方向鍵留給輸入法
    if (e.key === "ArrowDown") setActive(active + 1);
    else if (e.key === "ArrowUp") setActive(active - 1);
    else if (e.key === "Home" && e.altKey) setActive(0);
    else if (e.key === "End" && e.altKey) setActive(shown.length - 1);
    else if (e.key === "Enter") {
      if (shown[active] !== undefined) choose(shown[active]);
    } else if (e.key === "Escape") close();
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
  });

  // 用 pointerdown 而不是 click：不讓搜尋框先失焦
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  list.addEventListener("click", (e) => {
    const li = e.target.closest(".app-combo-option");
    if (li) choose(Number(li.dataset.index));
  });
  list.addEventListener("pointermove", (e) => {
    const li = e.target.closest(".app-combo-option");
    if (li) {
      const i = shown.indexOf(Number(li.dataset.index));
      if (i !== active) setActive(i);
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (isOpen() && !wrap.contains(e.target)) close(false);
  });

  // 外部改動 select 時跟著更新：change（含 Playwright select_option）、換 options、改 disabled
  select.addEventListener("change", syncButton);
  new MutationObserver(() => {
    syncButton();
    if (isOpen()) renderList();
  }).observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled"] });

  // 程式直接設 select.value／selectedIndex 不會觸發任何事件，攔下 setter 補一次同步
  for (const prop of ["value", "selectedIndex"]) {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(select, prop, {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        desc.set.call(this, v);
        syncButton();
      },
    });
  }

  syncButton();
  return { open, close, refresh: syncButton };
}
