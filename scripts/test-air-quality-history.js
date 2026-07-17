const assert = require('node:assert/strict');
const { dayBounds, monthUrls, buildDay, loadAirNowDay } = require('../lib/air-quality-history');

const spring = dayBounds('2026-03-08'), fall = dayBounds('2026-11-01');
assert.equal((spring.end - spring.start) / 3600_000, 23);
assert.equal((fall.end - fall.start) / 3600_000, 25);
assert.deepEqual(monthUrls(Date.UTC(2026, 5, 1), Date.UTC(2026, 6, 1)), [
  'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/2026/6.csv',
  'https://raw.githubusercontent.com/nychealth/nyccas-data/refs/heads/main/hist/csv/2026/7.csv'
]);

const bounds = dayBounds('2026-07-16'), observations = [];
for (let hour = -23; hour < 24; hour++) observations.push({
  siteId: '1', name: 'Test Monitor', lat: 40.75, lon: -73.99, value: 10 + (hour + 23) / 10,
  observedAt: bounds.start + hour * 3600_000, source: 'archive'
});
const histories = new Map([['1', observations.slice().sort((a, b) => b.observedAt - a.observedAt)]]);
const pack = buildDay('2026-07-16', histories, { date: '2026-07-16', aqi: 41, category: 'Good' });
assert.equal(pack.frames.length, 24);
assert.equal(pack.daily, pack.frames[23][0]);
assert.equal(pack.frames[0][1].length, 1);
assert.equal(pack.frames[0][1][0][5], Math.round(bounds.start / 60000));
assert.equal(pack.frames[0][1][0][11], 24);
assert.equal(pack.airNow.aqi, 41);

const missing = observations.filter(item => item.observedAt !== bounds.start + 12 * 3600_000);
const missingPack = buildDay('2026-07-16', new Map([['1', missing.slice().sort((a, b) => b.observedAt - a.observedAt)]]));
assert.equal(missingPack.frames.length, 23);
assert.equal(missingPack.frames.some(frame => frame[0] === Math.round((bounds.start + 13 * 3600_000) / 60000)), false);

function packForDay(day) {
  const range = dayBounds(day), rows = [];
  for (let observedAt = range.start - 23 * 3600_000; observedAt < range.end; observedAt += 3600_000) rows.push({ siteId:'dst', name:'DST Monitor', lat:40.75, lon:-73.99, value:12, observedAt });
  return buildDay(day, new Map([['dst', rows.slice().sort((a, b) => b.observedAt - a.observedAt)]]));
}
assert.equal(packForDay('2026-03-08').frames.length, 23);
assert.equal(packForDay('2026-11-01').frames.length, 25);

(async () => {
  const official = await loadAirNowDay('2026-07-16', {
    apiKey: 'test',
    fetchImpl: async url => {
      assert.match(String(url), /date=2026-07-16T00-0000/);
      return new Response(JSON.stringify([
        { DateObserved: '2026-07-16', HourObserved: 0, LocalTimeZone: 'EDT', ReportingArea: 'New York City Region', ParameterName: 'PM2.5', AQI: 56, Category: { Name: 'Moderate' } },
        { ReportingArea: 'New York City Region', ParameterName: 'O3', AQI: 30 }
      ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  assert.equal(official.aqi, 56);
  assert.equal(official.category, 'Moderate');
  const currentShape = await loadAirNowDay('2026-07-16', {
    apiKey: 'test',
    fetchImpl: async () => new Response(JSON.stringify({ data:[{ dateObserved:'2026-07-16', reportingAreaName:'New York City Region', parameterName:'PM2.5', nowcastAQI:44, aqiCategoryName:'Good' }] }), { status:200 })
  });
  assert.equal(currentShape.aqi, 44);
  assert.equal(currentShape.reportingArea, 'New York City Region');
  assert.equal(currentShape.category, 'Good');
  assert.equal(await loadAirNowDay('2026-07-16', { apiKey: '' }), null);
  console.log('air-quality history tests: pass');
})().catch(error => { console.error(error); process.exit(1); });
