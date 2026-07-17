const { STATIONS_URL, parseStations, parseArchive, fetchCsv, mergeObservations } = require('./nyccas-source');

const ROOT = 'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/';
const DAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const HOUR_MS = 3600_000;
const AIRNOW_URL = 'https://www.airnowapi.org/aq/observation/zipcode/historical/';

function dayAt(ms) {
  const parts = Object.fromEntries(DAY_FMT.formatToParts(ms).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function monthUrls(startMs, endMs) {
  const urls = [];
  const cursor = new Date(Date.UTC(new Date(startMs).getUTCFullYear(), new Date(startMs).getUTCMonth(), 1));
  const last = new Date(Date.UTC(new Date(endMs).getUTCFullYear(), new Date(endMs).getUTCMonth(), 1));
  while (cursor <= last) {
    urls.push(ROOT + cursor.getUTCFullYear() + '/' + (cursor.getUTCMonth() + 1) + '.csv');
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return urls;
}

function dayBounds(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('bad day');
  const center = Date.parse(day + 'T12:00:00Z');
  let start = center - 18 * HOUR_MS;
  while (dayAt(start) !== day) start += HOUR_MS;
  while (dayAt(start - HOUR_MS) === day) start -= HOUR_MS;
  let end = start + 24 * HOUR_MS;
  while (dayAt(end) === day) end += HOUR_MS;
  while (dayAt(end - HOUR_MS) !== day) end -= HOUR_MS;
  return { start, end };
}

function pm25Aqi(value) {
  const breaks = [[0, 9, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150], [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300], [225.5, 325.4, 301, 500]];
  const concentration = Math.floor(Math.max(0, value) * 10) / 10;
  const range = breaks.find(item => concentration >= item[0] && concentration <= item[1]);
  return range ? Math.round((range[3] - range[2]) / (range[1] - range[0]) * (concentration - range[0]) + range[2]) : concentration > 325.4 ? 500 : null;
}

function nowcast(values, referenceTime) {
  const recent = values.filter(item => referenceTime - item.observedAt >= 0 && referenceTime - item.observedAt < 12 * HOUR_MS);
  if (recent.filter(item => referenceTime - item.observedAt < 3 * HOUR_MS).length < 2) return null;
  const low = Math.min(...recent.map(item => item.value)), high = Math.max(...recent.map(item => item.value));
  const weight = high === 0 ? 1 : Math.max(0.5, 1 - (high - low) / high);
  let sum = 0, weights = 0;
  for (const item of recent) {
    const itemWeight = weight ** Math.max(0, Math.round((referenceTime - item.observedAt) / HOUR_MS));
    sum += item.value * itemWeight; weights += itemWeight;
  }
  return weights ? sum / weights : null;
}

function rowAt(history, observation) {
  const reference = observation.observedAt;
  const prior = history.find(item => reference - item.observedAt >= 30 * 60_000 && reference - item.observedAt <= 90 * 60_000);
  const recent = history.filter(item => reference - item.observedAt >= 0 && reference - item.observedAt < 12 * HOUR_MS);
  const peak = recent.reduce((highest, item) => !highest || item.value > highest.value ? item : highest, null);
  const averageRows = history.filter(item => reference - item.observedAt >= 0 && reference - item.observedAt < 24 * HOUR_MS);
  const average = averageRows.length >= 18 ? averageRows.reduce((sum, item) => sum + item.value, 0) / averageRows.length : null;
  const nowcastPm = nowcast(history, reference);
  return [observation.siteId, observation.name, +observation.lat.toFixed(5), +observation.lon.toFixed(5), +observation.value.toFixed(1),
    Math.round(reference / 60000), prior ? +(observation.value - prior.value).toFixed(1) : null,
    nowcastPm == null ? null : pm25Aqi(nowcastPm), peak ? +peak.value.toFixed(1) : +observation.value.toFixed(1),
    Math.round((peak ? peak.observedAt : reference) / 60000), average == null ? null : +average.toFixed(2), averageRows.length,
    nowcastPm == null ? null : +nowcastPm.toFixed(2)];
}

function buildDay(day, histories, official = null) {
  const { start, end } = dayBounds(day), frames = [];
  for (let frameEnd = start + HOUR_MS; frameEnd <= end; frameEnd += HOUR_MS) {
    const observedAt = frameEnd - HOUR_MS, rows = [];
    for (const history of histories.values()) {
      const observation = history.find(item => item.observedAt === observedAt);
      if (observation) rows.push(rowAt(history, observation));
    }
    rows.sort((a, b) => a[1].localeCompare(b[1]));
    if (rows.length) frames.push([Math.round(frameEnd / 60000), rows]);
  }
  return {
    v: 2, day, timeZone: 'America/New_York', interval: 'hour-ending', generatedAt: new Date().toISOString(),
    fields: 'siteId,name,lat,lon,latestHourlyPm25,observedEpochMin,delta1h,nowcastAqi,peak12hPm25,peak12hEpochMin,average24hPm25,average24hObservationCount,nowcastPm25',
    frames, daily: frames.length ? frames[frames.length - 1][0] : null, airNow: official,
    provenance: { monitors: 'NYC Health + Queens College — NYCCAS preliminary hourly PM2.5', official: official ? 'US EPA AirNow historical reporting-area observation' : null }
  };
}

function airNowKey() {
  if (process.env.AIRNOW_API_KEY) return process.env.AIRNOW_API_KEY;
  try {
    const raw = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'airnow-api-key.json'), 'utf8').trim();
    try { const parsed = JSON.parse(raw); return typeof parsed === 'string' ? parsed : parsed.key || parsed.apiKey || null; }
    catch { return raw || null; }
  } catch { return null; }
}

async function loadAirNowDay(day, options = {}) {
  const key = options.apiKey ?? airNowKey();
  if (!key) return null;
  const params = new URLSearchParams({ format: 'application/json', zipCode: '10001', date: day + 'T00-0000', distance: '25', API_KEY: key });
  const response = await (options.fetchImpl || fetch)(AIRNOW_URL + '?' + params, { headers: { Accept: 'application/json', 'User-Agent': 'manhattan-island' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('airnow_history_http_' + response.status);
  const body = await response.json(), candidates = Array.isArray(body) ? body : Array.isArray(body.Data) ? body.Data : Array.isArray(body.data) ? body.data : [];
  const pollutant = item => item.ParameterName ?? item.parameterName ?? item.parameter ?? '';
  const aqi = item => item.AQI ?? item.aqi ?? item.nowcastAQI;
  const reportingArea = item => item.ReportingArea ?? item.reportingArea ?? item.reportingAreaName ?? '';
  const rows = candidates.filter(item => /PM2\.5/i.test(String(pollutant(item))) && Number.isFinite(+aqi(item)));
  if (!rows.length) return null;
  const row = rows.find(item => /New York/i.test(String(reportingArea(item)))) || rows.sort((a, b) => +aqi(b) - +aqi(a))[0];
  return { date: day, reportingArea: reportingArea(row) || 'New York City Region, NY', pollutant: 'PM2.5', aqi: +aqi(row),
    category: row.Category && row.Category.Name || row.category && row.category.name || row.CategoryName || row.categoryName || row.aqiCategoryName || null,
    hourObserved: Number.isFinite(+(row.HourObserved ?? row.hourObserved)) ? +(row.HourObserved ?? row.hourObserved) : null,
    localTimeZone: row.LocalTimeZone || row.localTimeZone || 'EST', source: 'US EPA AirNow historical reporting-area observation' };
}

async function loadHistories(startMs, endMs, options = {}) {
  const fetchImpl = options.fetchImpl || fetch, nowMs = options.nowMs || Date.now();
  const stationResult = await fetchCsv(STATIONS_URL, 'stations', fetchImpl, nowMs);
  const stations = parseStations(stationResult.text);
  const sourceSets = await Promise.all(monthUrls(startMs - 24 * HOUR_MS, endMs).map(async (url, index) => {
    const result = await fetchCsv(url, 'archive' + index, fetchImpl, nowMs);
    return { observations: parseArchive(result.text, stations, nowMs) };
  }));
  return mergeObservations(sourceSets).histories;
}

async function loadDay(day, options = {}) {
  const bounds = dayBounds(day);
  const [histories, official] = await Promise.all([loadHistories(bounds.start, bounds.end, options), loadAirNowDay(day, options).catch(() => null)]);
  return buildDay(day, histories, official);
}

module.exports = { AIRNOW_URL, dayAt, dayBounds, monthUrls, pm25Aqi, nowcast, rowAt, buildDay, loadAirNowDay, loadHistories, loadDay };
