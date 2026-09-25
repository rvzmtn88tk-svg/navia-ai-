#!/usr/bin/env node
// Builds apps/mobile/assets/data/kyiv-oblast-shelters.json from the official
// open data of Kyiv-oblast communities on data.gov.ua ("Дані про розташування
// захисних споруд цивільного захисту", national dataset standard with lat/lon).
// Only rows with real coordinates inside Kyiv oblast are kept; nothing is
// invented. Re-run to refresh:  node scripts/data/build-kyiv-oblast-shelters.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../apps/mobile/assets/data/kyiv-oblast-shelters.json");
const UA = { headers: { "User-Agent": "NAVIA/0.1 (open data build)" } };
const BBOX = { minLat: 49.15, maxLat: 51.6, minLon: 29.2, maxLon: 32.2 }; // Kyiv oblast incl. Kyiv

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.some((f) => f.trim())) rows.push(row); }
  return rows;
}

const clean = (v) => (v == null || v === "null" ? "" : String(v).replace(/\s+/g, " ").trim());
const inBox = (lat, lon) => lat >= BBOX.minLat && lat <= BBOX.maxLat && lon >= BBOX.minLon && lon <= BBOX.maxLon;

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try { return await (await fetch(url, { ...UA, signal: ctrl.signal })).text(); } finally { clearTimeout(timer); }
}

const datasets = [];
for (let start = 0; start < 2000; start += 200) {
  const d = await (await fetch(`https://data.gov.ua/api/3/action/package_search?rows=200&start=${start}&q=${encodeURIComponent('"захисних споруд"')}`, UA)).json();
  const res = d.result?.results ?? [];
  if (!res.length) break;
  datasets.push(...res);
}

const shelters = [];
const sources = [];
for (const p of datasets) {
  for (const r of (p.resources ?? []).slice(0, 2)) {
    let rows = [];
    try {
      if (/csv/i.test(r.format ?? "")) {
        const csv = parseCsv(await fetchText(r.url));
        const head = (csv[0] ?? []).map((h) => h.trim());
        const idx = (k) => head.indexOf(k);
        if (idx("lat") < 0 || idx("lon") < 0) continue;
        rows = csv.slice(1).map((c) => ({
          uid: clean(c[idx("uid")]), type: clean(c[idx("type")]), region: clean(c[idx("addressAdminUnitL2")]),
          community: clean(c[idx("addressAdminUnitL4")]), settlement: clean(c[idx("addressPostName")]),
          street: clean(c[idx("addressThoroughfare")]), house: clean(c[idx("addressLocatorDesignator")]),
          lat: Number(clean(c[idx("lat")]).replace(",", ".")), lon: Number(clean(c[idx("lon")]).replace(",", ".")),
        })).filter((x) => /Київська/.test(x.region));
      } else if (/json/i.test(r.format ?? "")) {
        const j = JSON.parse(await fetchText(r.url));
        const list = j.ProtectiveStructures ?? [];
        rows = list.map((x) => {
          const [lat, lon] = clean(x.coordinatesShelter).split(/[,;]\s*/).map(Number);
          return { uid: clean(x.identifier), type: clean(x.typeShelter), region: "", community: clean(x.addressPostName), settlement: clean(x.addressPostName),
            street: clean(x.addressThoroughfare), house: clean(x.addressLocatorDesignator), lat, lon };
        });
      }
    } catch { continue; }
    const good = rows.filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon) && inBox(x.lat, x.lon));
    if (good.length === 0) continue;
    sources.push({ title: p.title, publisher: clean(p.organization?.title), url: r.url, modified: (p.metadata_modified ?? "").slice(0, 10), count: good.length });
    for (const x of good) {
      const address = [x.settlement, [x.street, x.house].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      shelters.push({
        id: `gov-${sources.length}-${x.uid || shelters.length}`,
        name: x.type ? x.type.charAt(0).toUpperCase() + x.type.slice(1) : "Захисна споруда",
        address, lat: Math.round(x.lat * 1e6) / 1e6, lon: Math.round(x.lon * 1e6) / 1e6,
        publisher: clean(p.organization?.title),
      });
    }
    break; // one resource per dataset
  }
}

// Drop exact duplicates published twice.
const seen = new Set();
const unique = shelters.filter((s) => { const k = `${s.lat},${s.lon},${s.address}`; if (seen.has(k)) return false; seen.add(k); return true; });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), source: "data.gov.ua — відкриті дані громад Київської області", sources, shelters: unique }));
console.log(`${unique.length} shelters from ${sources.length} datasets → ${OUT}`);
for (const s of sources) console.log(`  ${String(s.count).padStart(3)}  ${s.publisher}  (${s.modified})`);
