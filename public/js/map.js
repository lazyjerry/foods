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

export async function createMap(el, { lat, lng, zoom = 17, onPick }) {
  await loadCss();
  const L = window.L;
  if (!L) throw new Error("地圖元件載入失敗，請重新整理頁面");
  L.Icon.Default.imagePath = "/vendor/leaflet/images/";
  const map = L.map(el, { scrollWheelZoom: false }).setView([lat, lng], zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    // 全站是 Referrer-Policy: same-origin，圖磚請求會不帶 Referer 而被 OSM 擋（403）；圖磚只送網域（ADR 015）
    referrerPolicy: "strict-origin-when-cross-origin",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
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
