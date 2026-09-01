import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLhasaV1CmrSearchUrl,
  lhasaV1CollectionConceptId,
  lhasaV1ProductDate,
  lhasaV1ProducerGranuleId,
  parseLhasaV1CmrPayload,
  probeLhasaV1Granule,
} from "../lib/lhasa-v1-history.ts";

const date = "2016-08-06";
const producerGranuleId = "Global_Landslide_Nowcast_v1.1_20160806.tif";

function payload(link = "https://data.gesdisc.earthdata.nasa.gov/data/Landslide/Global_Landslide_Nowcast.1.1/2016/Global_Landslide_Nowcast_v1.1_20160806.tif") {
  return {
    feed: {
      entry: [{
        id: "G2041291075-GES_DISC",
        producer_granule_id: producerGranuleId,
        granule_size: "6.814237594604492",
        time_start: "2016-08-06T00:00:00.000Z",
        time_end: "2016-08-06T23:59:59.000Z",
        links: [{ rel: "http://esipfed.org/ns/fedsearch/1.1/data#", href: link }],
      }],
    },
  };
}

test("builds a bounded public CMR query for the official LHASA 1.1 collection", () => {
  const url = new URL(buildLhasaV1CmrSearchUrl(date));
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "cmr.earthdata.nasa.gov");
  assert.equal(url.searchParams.get("collection_concept_id"), lhasaV1CollectionConceptId);
  assert.equal(url.searchParams.get("page_size"), "5");
  assert.equal(lhasaV1ProducerGranuleId(date), producerGranuleId);
});

test("sends the CMR client identifier and bounds the metadata response", async () => {
  let request;
  const result = await probeLhasaV1Granule(date, async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify(payload()), { headers: { "content-type": "application/json" } });
  });
  assert.equal(result.status, "available");
  assert.equal(request.init.headers["Client-Id"], "tianxun-disaster-watch");
  assert.equal(request.init.headers.Accept, "application/json");
});

test("parses a real-shaped CMR granule without claiming the raster was downloaded", () => {
  const result = parseLhasaV1CmrPayload(payload(), date);
  assert.equal(result.status, "available");
  assert.equal(result.producerGranuleId, producerGranuleId);
  assert.equal(result.granuleConceptId, "G2041291075-GES_DISC");
  assert.equal(result.granuleSizeMb, 6.814237594604492);
  assert.match(result.message, /尚未下载/);
  assert.match(result.downloadUrl, /^https:\/\/data\.gesdisc\.earthdata\.nasa\.gov\//);
});

test("distinguishes missing metadata from invalid or untrusted responses", () => {
  assert.equal(parseLhasaV1CmrPayload({ feed: { entry: [] } }, date).status, "not_found");
  assert.throws(() => parseLhasaV1CmrPayload(payload("https://evil.example/history.tif"), date), /trusted GeoTIFF/);
  assert.throws(() => parseLhasaV1CmrPayload({ feed: {} }, date), /invalid feed/);
});

test("enforces the official archive coverage", () => {
  assert.equal(lhasaV1ProductDate("2000-06-14T12:00:00Z"), "2000-06-14");
  assert.equal(lhasaV1ProductDate("2020-12-31T23:00:00Z"), "2020-12-31");
  assert.equal(lhasaV1ProductDate("2000-06-13T23:59:59Z"), null);
  assert.equal(lhasaV1ProductDate("2021-01-01T00:00:00Z"), null);
});
