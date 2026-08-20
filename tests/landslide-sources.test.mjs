import assert from "node:assert/strict";
import test from "node:test";

async function landslideTools() {
  return import(new URL("../lib/landslide-sources.ts", import.meta.url));
}

test("USGS Ground Failure creates a review-only model-risk polygon, not an observed landslide", async () => {
  const { parseUsgsGroundFailureDetails } = await landslideTools();
  const payload = {
    type: "FeatureCollection",
    features: [{
      id: "us6000tlrj",
      properties: {
        mag: 5.9,
        place: "Central Afghanistan",
        time: 1_776_000_000_000,
        updated: 1_776_003_600_000,
        url: "https://earthquake.usgs.gov/earthquakes/eventpage/us6000tlrj",
        products: {
          "ground-failure": [{
            status: "UPDATE",
            updateTime: 1_776_003_600_000,
            properties: {
              eventtime: "2026-04-12T00:00:00Z",
              magnitude: "5.9",
              "landslide-alert": "yellow",
              "landslide-hazard-alert-value": "1.1",
              "landslide-population-alert-color": "green",
              "landslide-min-latitude": "33.1",
              "landslide-max-latitude": "36.4",
              "landslide-min-longitude": "67.2",
              "landslide-max-longitude": "71.8",
            },
          }],
        },
      },
    }],
  };
  const events = parseUsgsGroundFailureDetails(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].hazard, "landslide");
  assert.equal(events[0].phenomenonStage, "forecast");
  assert.equal(events[0].geometry.type, "Polygon");
  assert.equal(events[0].requiresReview, true);
  assert.match(events[0].description, /不是已经发生滑坡的边界/);

  payload.features[0].properties.products["ground-failure"][0].properties["landslide-alert"] = "green";
  assert.equal(parseUsgsGroundFailureDetails(payload).length, 0, "green background products must not flood the event list");
});

test("NVE warning keeps the MasterId across daily updates and interprets Oslo local time", async () => {
  const { nveWarningBoundaryKeys, parseNveLandslideWarning, parseNveLocalDate } = await landslideTools();
  const warning = {
    EventId: 9002,
    MasterId: 8999,
    ActivityLevel: 3,
    Area: "parts of Vestland",
    MunicipalityList: [{ Id: 4601, Name: "Bergen" }, { Id: 4640, Name: "Sogndal" }],
    ValidFrom: "19/08/2026 07:00:00",
    ValidTo: "20/08/2026 06:59:00",
    PublishTime: "19/08/2026 10:30:00",
    DangerTypeName: "landslide and debris-flow danger",
    MainText: "Orange regional warning due to intense rain.",
    ConsequenceText: "Several landslides may occur.",
    CapStatus: "actual",
  };
  assert.deepEqual(nveWarningBoundaryKeys(warning), [
    { kind: "kommuner", id: "4601" },
    { kind: "kommuner", id: "4640" },
  ]);
  assert.equal(parseNveLocalDate("19/08/2026 07:00:00"), "2026-08-19T05:00:00.000Z");
  assert.equal(parseNveLocalDate("22/12/2017 07:00:00"), "2017-12-22T06:00:00.000Z");
  const candidate = parseNveLandslideWarning(warning, {
    type: "Polygon",
    coordinates: [[[5, 60], [6, 60], [6, 61], [5, 60]]],
  }, Date.parse("2026-08-19T08:00:00Z"));
  assert.equal(candidate?.sourceEventId, "8999");
  assert.equal(candidate?.severity, "orange");
  assert.equal(candidate?.phenomenonStage, "warning");
  assert.match(candidate?.description ?? "", /不是已发生滑坡的遥感提取边界/);
});

test("Kartverket FeatureCollections become a bounded MultiPolygon", async () => {
  const { geoJsonBoundaryGeometry } = await landslideTools();
  const geometry = geoJsonBoundaryGeometry({
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[5, 60], [6, 60], [6, 61], [5, 60]]] } },
      { type: "Feature", geometry: { type: "Polygon", coordinates: [[[7, 61], [8, 61], [8, 62], [7, 61]]] } },
    ],
  });
  assert.equal(geometry?.type, "MultiPolygon");
  assert.equal(geometry?.coordinates.length, 2);
});
