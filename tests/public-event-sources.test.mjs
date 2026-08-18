import assert from "node:assert/strict";
import test from "node:test";

async function sourceTools() {
  return import(new URL("../lib/public-event-sources.ts", import.meta.url));
}

test("parses official NWS polygons and excludes non-observable thunderstorm alerts", async () => {
  const { parseNwsAlerts } = await sourceTools();
  const base = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [[[-97, 40], [-96, 40], [-96, 41], [-97, 40]]] },
    properties: {
      id: "urn:oid:nws-test-1",
      status: "Actual",
      messageType: "Alert",
      sent: "2026-08-18T06:00:00Z",
      onset: "2026-08-18T06:00:00Z",
      expires: "2026-08-19T06:00:00Z",
      severity: "Severe",
      urgency: "Immediate",
      certainty: "Observed",
      areaDesc: "Test County",
    },
  };
  const events = parseNwsAlerts({ features: [
    { ...base, properties: { ...base.properties, event: "Flash Flood Warning", headline: "Flash flood observed" } },
    { ...base, id: "other", properties: { ...base.properties, id: "urn:oid:nws-test-2", event: "Severe Thunderstorm Warning" } },
  ] }, Date.parse("2026-08-18T07:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].hazard, "flood");
  assert.equal(events[0].geometry.type, "Polygon");
  assert.equal(events[0].requiresReview, true);
});

test("parses EMSC M4.5+ points and keeps independent catalogue identity", async () => {
  const { parseEmscEvents } = await sourceTools();
  const events = parseEmscEvents({ features: [{
    id: "20260818_0000233",
    geometry: { type: "Point", coordinates: [134.22, -1, 11] },
    properties: { time: "2026-08-18T07:02:29Z", lastupdate: "2026-08-18T07:07:31Z", flynn_region: "PAPUA, INDONESIA", depth: 11, mag: 5.2, magtype: "Mw" },
  }] });
  assert.equal(events.length, 1);
  assert.equal(events[0].sourceEventId, "20260818_0000233");
  assert.equal(events[0].severity, "yellow");
  assert.equal(events[0].magnitude, 5.2);
});

test("parses ECCC warning areas but filters ended and irrelevant alerts", async () => {
  const { parseEcccAlerts } = await sourceTools();
  const feature = {
    id: "eccc-fire-1",
    geometry: { type: "Polygon", coordinates: [[[-124, 52], [-123, 52], [-123, 53], [-124, 52]]] },
    properties: {
      alert_type: "warning",
      alert_name_en: "forest fire warning",
      alert_text_en: "An active forest fire is affecting the warning polygon.",
      publication_datetime: "2026-08-18T06:00:00Z",
      validity_datetime: "2026-08-18T06:00:00Z",
      expiration_datetime: "2026-08-19T06:00:00Z",
      risk_colour_en: "yellow",
      feature_name_en: "Chilcotin",
      province: "BC",
      status_en: "in effect",
    },
  };
  const events = parseEcccAlerts({ features: [feature, { ...feature, id: "ended", properties: { ...feature.properties, status_en: "ended" } }] }, Date.parse("2026-08-18T07:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].hazard, "wildfire");
  assert.equal(events[0].requiresReview, true);
  assert.equal(events[0].phenomenonStage, "warning");
  const smokeOnly = parseEcccAlerts({ features: [{ ...feature, id: "smoke", properties: { ...feature.properties, alert_name_en: "air quality warning", alert_text_en: "Wildfire smoke only." } }] }, Date.parse("2026-08-18T07:00:00Z"));
  assert.equal(smokeOnly.length, 0, "smoke advisories are drivers/context, not observed wildfire events");
});

test("turns Copernicus WKT AOIs into a MultiPolygon without treating them as damage boundaries", async () => {
  const { parseCopernicusActivations, parseWktGeometry } = await sourceTools();
  assert.deepEqual(parseWktGeometry("POINT (13.0 46.4)"), { type: "Point", coordinates: [13, 46.4] });
  const events = parseCopernicusActivations({ results: [{
    code: "EMSR924",
    name: "Wildfire in Friuli, Italy",
    category: "Wildfire",
    subCategory: "Forest fire",
    eventTime: "2026-08-13T22:00:00",
    activationTime: "2026-08-16T08:46:00",
    lastUpdate: "2026-08-17T16:43:29",
    closed: false,
    countries: [{ name: "Italy" }],
    reason: "Rapid mapping requested.",
    aois: [
      { extent: "POLYGON ((12.9 46.3, 13.1 46.3, 13.1 46.5, 12.9 46.3))" },
      { extent: "POLYGON ((13.2 46.3, 13.3 46.3, 13.3 46.4, 13.2 46.3))" },
    ],
  }] }, Date.parse("2026-08-18T07:00:00Z"));
  assert.equal(events.length, 1);
  assert.equal(events[0].geometry.type, "MultiPolygon");
  assert.match(events[0].description, /not the final affected-area delineation/);
  assert.equal(events[0].occurredAt, "2026-08-13T22:00:00.000Z");

  const centroidOnly = parseCopernicusActivations({ results: [{
    code: "EMSR925",
    name: "Flood mapping activation",
    category: "Flood",
    eventTime: "2026-08-18T01:00:00",
    lastUpdate: "2026-08-18T02:00:00",
    closed: false,
    centroid: "POINT (120.3 31.5)",
  }] }, Date.parse("2026-08-18T07:00:00Z"));
  assert.equal(centroidOnly[0].requiresReview, true);
});
