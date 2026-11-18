// 用量（設定頁「用量」卡）：D1 資料庫大小、R2 照片總量、今日 D1 讀寫列數與 Worker 請求數，結果快取在 D1 storage_stats。
// - D1 大小取自查詢回傳的 meta.size_after；R2 binding 沒有容量 API，只能 list() 逐頁加總物件大小。
// - 讀寫列數與請求數 binding 拿不到（meta 只有單次查詢的列數），要查 GraphQL Analytics API，
//   需要 CF_ACCOUNT_ID 與 CF_ANALYTICS_TOKEN（權限 Account Analytics:Read）；沒設定就略過這一段。
//   查的是帳號合計、UTC 當日：免費方案的每日額度（D1 讀 500 萬列、寫 10 萬列，Worker 10 萬次請求）也是這樣算。
// 快取過期時先回舊值、背景重算（stale-while-revalidate），請求不必等 R2 列舉與外部 API。
import { json } from "./http.js";

const CACHE_TTL_MS = 60 * 60 * 1000;
const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const USAGE_QUERY = `query ($account: String!, $date: Date!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $account }) {
      d1AnalyticsAdaptiveGroups(limit: 10000, filter: { date_geq: $date, date_leq: $date }) { sum { rowsRead rowsWritten } }
      workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } }
    }
  }
}`;

async function measureStorage(env) {
  const probe = await env.DB.prepare("SELECT 1").run();
  const d1Bytes = Number(probe.meta?.size_after) || 0;
  let r2Bytes = 0;
  let r2Objects = 0;
  let cursor;
  do {
    const page = await env.PHOTOS.list({ cursor, limit: 1000 });
    for (const obj of page.objects) r2Bytes += obj.size;
    r2Objects += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { d1_bytes: d1Bytes, r2_bytes: r2Bytes, r2_objects: r2Objects };
}

async function measureUsage(env, now) {
  const empty = { usage_date: null, d1_rows_read: null, d1_rows_written: null, worker_requests: null };
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return empty;
  const date = now.toISOString().slice(0, 10);
  try {
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: USAGE_QUERY, variables: { account: env.CF_ACCOUNT_ID, date, start: `${date}T00:00:00Z`, end: now.toISOString() } }),
    });
    const body = await res.json();
    const acc = body?.data?.viewer?.accounts?.[0];
    if (!res.ok || body?.errors?.length || !acc) throw new Error(JSON.stringify(body?.errors || res.status));
    const total = (groups, key) => groups.reduce((n, g) => n + (Number(g.sum?.[key]) || 0), 0);
    return {
      usage_date: date,
      d1_rows_read: total(acc.d1AnalyticsAdaptiveGroups, "rowsRead"),
      d1_rows_written: total(acc.d1AnalyticsAdaptiveGroups, "rowsWritten"),
      worker_requests: total(acc.workersInvocationsAdaptive, "requests"),
    };
  } catch (err) {
    console.error("usage analytics failed", err);
    return empty;
  }
}

async function measure(env) {
  const now = new Date();
  const [storage, usage] = await Promise.all([measureStorage(env), measureUsage(env, now)]);
  const row = { ...storage, ...usage, updated_at: now.toISOString() };
  await env.DB
    .prepare(`INSERT INTO storage_stats (id, d1_bytes, r2_bytes, r2_objects, usage_date, d1_rows_read, d1_rows_written, worker_requests, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET d1_bytes = excluded.d1_bytes, r2_bytes = excluded.r2_bytes, r2_objects = excluded.r2_objects,
        usage_date = excluded.usage_date, d1_rows_read = excluded.d1_rows_read, d1_rows_written = excluded.d1_rows_written,
        worker_requests = excluded.worker_requests, updated_at = excluded.updated_at`)
    .bind(row.d1_bytes, row.r2_bytes, row.r2_objects, row.usage_date, row.d1_rows_read, row.d1_rows_written, row.worker_requests, row.updated_at)
    .run();
  return row;
}

function toBody(row, refreshing) {
  return {
    d1: { usedBytes: row.d1_bytes },
    r2: { usedBytes: row.r2_bytes, objects: row.r2_objects },
    usage: row.usage_date == null ? null : {
      date: row.usage_date,
      d1RowsRead: row.d1_rows_read,
      d1RowsWritten: row.d1_rows_written,
      workerRequests: row.worker_requests,
    },
    updatedAt: row.updated_at,
    refreshing,
  };
}

export async function storageUsage(env, ctx) {
  const row = await env.DB.prepare("SELECT * FROM storage_stats WHERE id = 1").first();
  if (!row) return json(toBody(await measure(env), false));
  const stale = Date.now() - Date.parse(row.updated_at) > CACHE_TTL_MS;
  if (stale) ctx.waitUntil(measure(env).catch((err) => console.error("storage measure failed", err)));
  return json(toBody(row, stale));
}
