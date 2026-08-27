import assert from "node:assert/strict";
import test from "node:test";

async function geohazards() {
  return import(new URL("../lib/china-geohazard-sources.ts", import.meta.url));
}

const article = (title, publishedAt, fragmentedDate = false) => `<!doctype html><html><head>
  <meta name="ArticleTitle" content="${title}"/>
  <meta name="PubDate" content="${publishedAt}"/>
  </head><body><div class=TRS_Editor>
  <p>${fragmentedDate ? "<font>8</font> 月 <font>26</font> 日 <font>10</font> 时 <font>30</font> 分" : "8月26日10时30分"}许，因尼泊尔一侧发生泥石流灾害，造成西藏日喀则市吉隆县吉隆口岸重大人员伤亡、失联。</p>
  <p>国家防灾减灾救灾委员会、应急管理部启动国家二级救灾应急响应。</p>
  </div></body></html>`;

test("extracts recent MEM geohazard links without treating generic news as events", async () => {
  const { parseMemGeohazardListing } = await geohazards();
  const listing = `<div class="tonglan_list"><li><a href="./202608/t20260826_708718.shtml">西藏吉隆泥石流救援<span>2026-08-26 18:59</span></a></li>
    <li><a href="./202608/t20260826_708709.shtml">调拨救灾物资<span>2026-08-26 17:55</span></a></li></div>`;
  const items = parseMemGeohazardListing(listing, Date.parse("2026-08-27T02:00:00Z"));
  assert.equal(items.length, 1);
  assert.equal(items[0].url, "https://www.mem.gov.cn/xw/yjglbgzdt/202608/t20260826_708718.shtml");
  assert.equal(items[0].publishedAt, "2026-08-26T10:59:00.000Z");
});

test("models the Jilong bulletin as one confirmed cross-border debris-flow event across updates", async () => {
  const { parseMemGeohazardBulletin } = await geohazards();
  const first = parseMemGeohazardBulletin(article("西藏日喀则市吉隆县遭受泥石流灾害 国家启动二级救灾应急响应", "2026-08-26 18:59:00"), "https://www.mem.gov.cn/xw/yjglbgzdt/202608/t20260826_708718.shtml");
  const update = parseMemGeohazardBulletin(article("应急管理部调派中国救援队增援西藏日喀则泥石流救援", "2026-08-27 08:52:00", true), "https://www.mem.gov.cn/xw/yjglbgzdt/202608/t20260827_708753.shtml");
  assert.ok(first);
  assert.ok(update);
  assert.equal(first.hazardSubtype, "debris_flow");
  assert.equal(first.occurredAt, "2026-08-26T02:30:00.000Z");
  assert.equal(first.locationQuery, "西藏自治区日喀则市吉隆县吉隆口岸");
  assert.equal(first.originCountry, "尼泊尔");
  assert.deepEqual(first.affectedCountries, ["中国"]);
  assert.equal(first.crossBorder, true);
  assert.equal(first.sourceEventId, update.sourceEventId, "daily rescue bulletins must update one master process");
  assert.equal(update.updatedAt, "2026-08-27T00:52:00.000Z");
  assert.match(first.description, /不是官方灾害边界/);
});

test("rejects emergency-response prose that does not confirm a physical occurrence", async () => {
  const { parseMemGeohazardBulletin } = await geohazards();
  const html = article("应急管理部针对云南启动国家地质灾害四级应急响应", "2026-08-23 18:27:00")
    .replace("发生泥石流灾害", "可能发生地质灾害")
    .replace("造成西藏日喀则市吉隆县吉隆口岸重大人员伤亡、失联", "要求做好监测预警和转移避险");
  assert.equal(parseMemGeohazardBulletin(html, "https://www.mem.gov.cn/xw/yjglbgzdt/202608/t20260823_708258.shtml"), null);
});
