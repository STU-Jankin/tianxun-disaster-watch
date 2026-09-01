import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { queryJiangsuExposureIndex } from "./index-core.mjs";

const indexPath = process.env.JIANGSU_OSM_INDEX_PATH?.trim() || "/var/lib/tianxun/osm-jiangsu/jiangsu.sqlite";
const port = boundedInteger(process.env.JIANGSU_OSM_PORT, 8791, 1024, 65_535);
const token = process.env.JIANGSU_OSM_API_TOKEN?.trim() || "";
if (!token && process.env.JIANGSU_OSM_ALLOW_NO_TOKEN !== "true") throw new Error("JIANGSU_OSM_API_TOKEN 未配置");
const database = new DatabaseSync(indexPath, { readOnly: true });
database.prepare("SELECT value FROM metadata WHERE key='schema_version'").get();

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      const metadata = Object.fromEntries(database.prepare("SELECT key, value FROM metadata WHERE key IN ('schema_version','source_timestamp','generated_at')").all().map((row) => [row.key, row.value]));
      return sendJson(response, 200, { ok: true, ...metadata });
    }
    if (request.method !== "POST" || request.url !== "/v1/exposure") return sendJson(response, 404, { error: "not_found" });
    if (!authorized(request.headers.authorization)) return sendJson(response, 401, { error: "unauthorized" });
    const body = JSON.parse(await readBody(request, 256 * 1024));
    const result = queryJiangsuExposureIndex(database, body?.geometry, { facilityLimit: body?.facilityLimit });
    return sendJson(response, 200, result);
  } catch (error) {
    return sendJson(response, error instanceof SyntaxError ? 400 : 422, { error: (error instanceof Error ? error.message : "query_failed").slice(0, 240) });
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`Jiangsu OSM index listening on 127.0.0.1:${port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => {
  database.close();
  process.exit(0);
}));

function authorized(header) {
  if (!token) return true;
  const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  response.end(payload);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
