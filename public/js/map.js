// Leaflet 地圖。leaflet.css 自行託管、在這裡動態載入（見 ADR：Leaflet 樣式表與 Jerry UI 規則衝突）。
const CSS_HREF = "/vendor/leaflet/leaflet.css";

function loadCss() {
  return new Promise((resolve) => {
    if (document.querySelector("link[data-leaflet]")) return resolve();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = CSS_HREF;
    link.dataset.leaflet = "";
    link.onload = resolve;
    link.onerror = resolve;
    document.head.appendChild(link);
  });
}

function addTiles(L, map) {
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    // 全站是 Referrer-Policy: same-origin，圖磚請求會不帶 Referer 而被 OSM 擋（403）；圖磚只送網域（ADR 015）
    referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
}

export async function createMap(el, { lat, lng, zoom = 17, onPick }) {
  await loadCss();
  const L = window.L;
  if (!L) throw new Error("地圖元件載入失敗，請重新整理頁面");
  L.Icon.Default.imagePath = "/vendor/leaflet/images/";
  const map = L.map(el, { scrollWheelZoom: false }).setView([lat, lng], zoom);
  addTiles(L, map);
  const marker = L.marker([lat, lng], { draggable: true, keyboard: true, title: "店家位置，可拖曳", alt: "店家位置" }).addTo(map);
  marker.on("dragend", () => {
    const p = marker.getLatLng();
    onPick(p.lat, p.lng);
  });
  map.on("click", (e) => {
    marker.setLatLng(e.latlng);
    onPick(e.latlng.lat, e.latlng.lng);
  });
  return {
    setPosition(la, ln, z) {
      marker.setLatLng([la, ln]);
      map.setView([la, ln], z ?? map.getZoom());
    },
  };
}

// 首頁地圖模式（ADR 029）：leaflet.js 等切到地圖才載入，列表模式不多下載。
const JS_SRC = "/vendor/leaflet/leaflet.js";
const FALLBACK_VIEW = { lat: 25.0478, lng: 121.517, zoom: 12 }; // 沒有任何點評時的起點：台北車站一帶
let scriptLoading = null;

function loadScript() {
  if (window.L) return Promise.resolve();
  scriptLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = JS_SRC;
    s.onload = resolve;
    s.onerror = () => {
      scriptLoading = null;
      s.remove();
      reject(new Error("地圖元件載入失敗，請重新整理頁面"));
    };
    document.head.appendChild(s);
  });
  return scriptLoading;
}

// places：[{ lat, lng, label, count }]；pin(place)／popup(place) 回傳已跳脫的 HTML，由呼叫端決定圖釘與 popup 內容。
// 畫面上靠得太近的圖釘合併成群組方塊（顯示 count 加總），點一下放大到分得開；已是最大縮放就不合併。
// 容器要在可見狀態下呼叫 show()，fitBounds 才算得出範圍；從隱藏切回可見時先呼叫 refresh()。
const CLUSTER_PX = 44; // 兩支圖釘中心相距小於這個像素就合併

export async function createReviewMap(el, { pin, popup }) {
  await Promise.all([loadCss(), loadScript()]);
  const L = window.L;
  if (!L) throw new Error("地圖元件載入失敗，請重新整理頁面");
  const map = L.map(el, { scrollWheelZoom: false }).setView([FALLBACK_VIEW.lat, FALLBACK_VIEW.lng], FALLBACK_VIEW.zoom);
  addTiles(L, map);
  const layer = L.layerGroup().addTo(map);
  let current = [];

  function placeMarker(place) {
    // 圖釘尺寸與錨點要跟 app.css 的 .app-pin 對齊：32px 方塊轉 45° 後尖端約在 (18, 39)
    const icon = L.divIcon({ className: "app-pin-icon", html: pin(place), iconSize: [36, 42], iconAnchor: [18, 39], popupAnchor: [0, -36] });
    return L.marker([place.lat, place.lng], { icon, keyboard: true, title: place.label, riseOnHover: true })
      .bindPopup(() => popup(place), { minWidth: 240, maxWidth: 300, autoPanPadding: [16, 16], autoPanPaddingTopLeft: [56, 16] });
  }

  function clusterMarker(places) {
    const count = places.reduce((n, p) => n + (p.count || 1), 0);
    const bounds = L.latLngBounds(places.map((p) => [p.lat, p.lng]));
    const icon = L.divIcon({ className: "app-pin-icon", html: `<span class="app-pin-cluster">${count}</span>`, iconSize: [36, 36], iconAnchor: [18, 18] });
    return L.marker(bounds.getCenter(), { icon, keyboard: true, title: `附近 ${count} 筆點評，點一下放大`, riseOnHover: true })
      .on("click", () => map.fitBounds(bounds, { padding: [60, 60], maxZoom: map.getMaxZoom() }));
  }

  function render() {
    layer.clearLayers();
    const zoom = map.getZoom();
    const groups = [];
    for (const place of current) {
      const pt = map.project([place.lat, place.lng], zoom);
      const near = zoom < map.getMaxZoom() && groups.find((g) => g.pt.distanceTo(pt) < CLUSTER_PX);
      if (near) near.places.push(place);
      else groups.push({ pt, places: [place] });
    }
    for (const g of groups) layer.addLayer(g.places.length === 1 ? placeMarker(g.places[0]) : clusterMarker(g.places));
  }

  map.on("zoomend", render);
  return {
    show(places) {
      current = places;
      if (places.length) map.fitBounds(L.latLngBounds(places.map((p) => [p.lat, p.lng])), { padding: [40, 40], maxZoom: 16 });
      render();
    },
    refresh() {
      map.invalidateSize();
    },
  };
}
