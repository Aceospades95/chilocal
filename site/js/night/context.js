/* context.js — tonight's conditions: clock, season, and Chicago weather.
 * Weather via Open-Meteo (free, keyless; https://open-meteo.com). Cached for
 * 30 minutes. If the fetch fails we fall back to season-typical defaults and
 * say so — the engine degrades gracefully, it never blocks the decision. */

const CHI = { lat: 41.8781, lng: -87.6298 };
const CACHE_KEY = "chilocal.wx.v1";
const TTL = 30 * 60 * 1000;

const WMO = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast",
  45: "foggy", 48: "foggy", 51: "drizzle", 53: "drizzle", 55: "drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow",
  80: "showers", 81: "showers", 82: "downpours", 85: "snow showers", 86: "snow showers",
  95: "thunderstorms", 96: "thunderstorms", 99: "thunderstorms",
};

export async function getWeather() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (cached && Date.now() - cached.at < TTL) return cached.wx;
  } catch { /* ignore */ }
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CHI.lat}&longitude=${CHI.lng}` +
      `&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
      `&hourly=precipitation_probability,temperature_2m&forecast_hours=8` +
      `&daily=sunset&forecast_days=1&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("wx " + r.status);
    const d = await r.json();
    const probs = d.hourly?.precipitation_probability || [];
    const eveningProb = probs.length ? Math.max(...probs.slice(0, 8)) : null;
    const wx = {
      ok: true,
      temp: d.current?.temperature_2m ?? null,
      feels: d.current?.apparent_temperature ?? null,
      code: d.current?.weather_code ?? null,
      desc: WMO[d.current?.weather_code] || "—",
      wind: d.current?.wind_speed_10m ?? null,
      precipProb: eveningProb,
      sunset: d.daily?.sunset?.[0] || null,
    };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), wx })); } catch { /* ignore */ }
    return wx;
  } catch {
    return { ok: false, temp: null, desc: null, precipProb: null, sunset: null };
  }
}

/* Chicago-local clock pieces, robust to viewing from another timezone. */
export function chicagoNow() {
  const now = new Date();
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", weekday: "short", hour: "numeric",
    minute: "numeric", hour12: false, month: "numeric", day: "numeric", year: "numeric",
  }).formatToParts(now).reduce((o, x) => ((o[x.type] = x.value), o), {});
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const hour = +p.hour % 24, minute = +p.minute;
  return {
    day, hour, minute, minutes: hour * 60 + minute,
    month: +p.month - 1,
    dateLabel: `${p.weekday} ${p.month}/${p.day}`,
    nightKey: `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`,
  };
}

export async function buildContext() {
  const clock = chicagoNow();
  const wx = await getWeather();
  // If it's before 5pm, we're planning ahead: evaluate "open" at 7:30pm.
  const planMinutes = clock.hour < 17 ? 19.5 * 60 : clock.minutes;
  let sunsetLabel = null;
  if (wx.sunset) {
    const m = wx.sunset.match(/T(\d{2}):(\d{2})/);
    if (m) { const h = +m[1] % 12 || 12; sunsetLabel = `${h}:${m[2]} sunset`; }
  }
  return { ...clock, ...wx, planMinutes, sunsetLabel };
}
