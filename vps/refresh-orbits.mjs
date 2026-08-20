const token = process.env.TIANXUN_API_TOKEN?.trim();
if (!token || token.length < 32) throw new Error("TIANXUN_API_TOKEN is missing or too weak");

const response = await fetch("http://127.0.0.1:3000/api/satellites", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "Tianxun-Orbit-Refresh/1.0",
  },
  signal: AbortSignal.timeout(120_000),
});

const text = await response.text();
if (text.length > 1_000_000) throw new Error("satellite refresh response exceeds safety limit");
let result;
try { result = JSON.parse(text); }
catch { throw new Error(`satellite refresh returned invalid JSON (HTTP ${response.status})`); }
if (!response.ok) throw new Error(`satellite refresh failed (HTTP ${response.status})`);
if (!result.refresh || Number(result.refresh.success) < 1) throw new Error("CelesTrak refresh produced no valid TLE; previous cache was retained");

console.log(JSON.stringify({
  status: result.state,
  attemptedAt: result.refresh.attemptedAt,
  refreshed: result.refresh.success,
  failed: result.refresh.failed,
  available: result.summary?.available,
  current: result.summary?.current,
}));
