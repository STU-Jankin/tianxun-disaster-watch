import assert from "node:assert/strict";
import test from "node:test";

import { buildNasaGlcPilot, nasaGlcDatasetUrl, nasaGlcPilotPrefix } from "../lib/official-landslide-benchmark.ts";

const headers = ["source_name", "source_link", "event_id", "event_date", "event_title", "location_accuracy", "landslide_category", "landslide_trigger", "country_name", "country_code", "longitude", "latitude"];

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function row(index, category, countryPrefix, overrides = {}) {
  const values = {
    source_name: `Authority ${countryPrefix}${index}`,
    source_link: `https://example.gov/events/${countryPrefix.toLowerCase()}-${index}`,
    event_id: `${category}-${index}`,
    event_date: `${String((index % 12) + 1).padStart(2, "0")}/${String((index % 27) + 1).padStart(2, "0")}/2015 12:00:00 AM`,
    event_title: index === 0 ? `Strict ${category}, quoted place` : `Strict ${category} ${index}`,
    location_accuracy: index % 3 === 0 ? "exact" : index % 3 === 1 ? "1km" : "5km",
    landslide_category: category,
    landslide_trigger: index % 2 ? "rain" : "downpour",
    country_name: `Country ${countryPrefix}${index}`,
    country_code: `${countryPrefix}${index}`,
    longitude: -120 + index,
    latitude: 20 + index * 0.1,
    ...overrides,
  };
  return headers.map((header) => csvCell(values[header])).join(",");
}

function pilotCsv() {
  const lines = [headers.join(",")];
  for (let index = 0; index < 13; index += 1) lines.push(row(index, "landslide", "L"));
  for (let index = 0; index < 5; index += 1) lines.push(row(index + 20, "mudslide", "M"));
  for (let index = 0; index < 2; index += 1) lines.push(row(index + 30, "debris_flow", "D"));
  lines.push(row(80, "landslide", "X", { location_accuracy: "25km" }));
  lines.push(row(81, "landslide", "X", { landslide_trigger: "earthquake" }));
  lines.push(row(82, "landslide", "X", { source_link: "http://insecure.example/events/82" }));
  return `${lines.join("\r\n")}\r\n`;
}

test("builds a deterministic 20-case NASA GLC pilot using only strict rainfall records", () => {
  const first = buildNasaGlcPilot(pilotCsv());
  const second = buildNasaGlcPilot(pilotCsv());
  assert.deepEqual(first, second);
  assert.equal(first.stats.sourceRows, 23);
  assert.equal(first.stats.eligibleRows, 20);
  assert.equal(first.stats.selectedRows, 20);
  assert.deepEqual(first.stats.categories, { debris_flow: 2, mudslide: 5, landslide: 13 });
  assert.equal(first.cases.length, 20);
  assert.equal(new Set(first.cases.map((item) => item.caseId)).size, 20);
  assert.ok(first.cases.every((item) => item.caseId.startsWith(nasaGlcPilotPrefix)));
  assert.ok(first.cases.every((item) => item.verificationStatus === "draft"));
  assert.ok(first.cases.every((item) => item.outcome === "event"));
  assert.ok(first.cases.every((item) => item.locationToleranceKm >= 2 && item.locationToleranceKm <= 7));
  assert.ok(first.cases.every((item) => item.provenanceUrl === nasaGlcDatasetUrl));
  assert.ok(first.cases.every((item) => item.occurredAt.endsWith("T12:00:00.000Z")));
  assert.ok(first.cases.some((item) => item.title.includes("quoted place")));
  assert.ok(first.cases.every((item) => /核对原始来源/.test(item.notes)));
});

test("rejects malformed or structurally incomplete NASA GLC exports", () => {
  assert.throws(() => buildNasaGlcPilot("event_id,event_date\n1,2020-01-01\n"), /missing event_title/);
  assert.throws(() => buildNasaGlcPilot(`${headers.join(",")}\n"unterminated`), /unterminated/);
});

test("does not treat repeated reporting of one incident as independent samples", () => {
  const shared = "https://example.gov/events/shared-report";
  const lines = [
    headers.join(","),
    row(30, "debris_flow", "US", { source_link: shared, country_name: "United States", country_code: "US" }),
    row(31, "debris_flow", "US", { source_link: shared, country_name: "United States", country_code: "US" }),
    row(32, "debris_flow", "CA", { source_link: "https://example.gov/events/independent", country_name: "Canada", country_code: "CA" }),
  ];
  const result = buildNasaGlcPilot(`${lines.join("\n")}\n`, 2);
  assert.equal(result.cases.length, 2);
  assert.equal(result.cases.filter((item) => item.notes.includes(shared)).length, 1);
});
