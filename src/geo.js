// 地址與座標互轉：代理 OpenStreetMap Nominatim。
// 使用政策：可識別的 User-Agent、每秒 1 次以內、不做邊打邊查；這裡另外用 Cache API 快取 1 天。
import { HttpError, json } from "./http.js";

const BASE = "https://nominatim.openstreetmap.org";
const UA = "food-review-worker/1.0 (personal food review app on Cloudflare Workers)";

// 台灣地址照「縣市→區→路→號」排；其他國家用 Nominatim 的 display_name。
export function formatAddress(place) {
  const a = place.address || {};
  if (a.country_code !== "tw") return place.display_name || "";
  // 只留行政區（縣市區鄉鎮），略過「信義商圈」「西村里」這類 OSM 的區塊名稱
  const admin = [a.state, a.county, a.city, a.town, a.city_district, a.suburb].filter((p) => p && /[縣市區鄉鎮]$/.test(p));
  const parts = [...admin, a.road];
  const seen = new Set();
  let out = "";
  for (const p of parts) {
    if (p && !seen.has(p)) {
      seen.add(p);
      out += p;
    }
  }
  if (a.house_number) out += /^\d+(-\d+)?$/.test(a.house_number) ? `${a.house_number}號` : a.house_number;
  const name = place.name && !out.includes(place.name) ? place.name : "";
  return (out || place.display_name || "") + (name ? ` ${name}` : "");
}

async function cachedFetch(url, ctx) {
  const cache = caches.default;
  const key = new Request(url);
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.5" } });
  if (!res.ok) throw new HttpError(502, `地址服務暫時無法使用（${res.status}），請稍後再試或手動輸入`);
  const data = await res.json();
  const store = new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" } });
  ctx.waitUntil(cache.put(key, store));
  return data;
}

// 地址查座標：REST（geoSearch）與 MCP 的 foods_geocode（src/mcp.js）共用
export async function searchPlaces(input, ctx) {
  const q = String(input ?? "").trim();
  if (!q) throw new HttpError(400, "請先輸入地址");
  if ([...q].length > 200) throw new HttpError(400, "地址最多 200 字");
  const target = `${BASE}/search?format=jsonv2&addressdetails=1&limit=5&accept-language=zh-TW&q=${encodeURIComponent(q)}`;
  const data = await cachedFetch(target, ctx);
  return data.map((p) => ({ lat: Number(p.lat), lng: Number(p.lon), address: formatAddress(p), label: p.display_name }));
}

export async function geoSearch(url, ctx) {
  return json({ results: await searchPlaces(url.searchParams.get("q"), ctx) });
}

export async function geoReverse(url, ctx) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "座標格式錯誤");
  // 四捨五入到小數 5 位（約 1 公尺）提高快取命中。
  const target = `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=zh-TW&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`;
  const data = await cachedFetch(target, ctx);
  if (data.error) throw new HttpError(404, "這個座標查不到地址，請手動輸入");
  return json({ address: formatAddress(data), label: data.display_name });
}
