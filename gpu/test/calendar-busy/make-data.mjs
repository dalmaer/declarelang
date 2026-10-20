// make-data.mjs — a busy office calendar for the GPU renderer's load tests: the calendar
// program unchanged (calendar-busy.declare is a copy), with far more events per day.
//
//   node gpu/test/calendar-busy/make-data.mjs     → data/events.json (deterministic)
//
// Weekdays: a 9:00 standup, then 7–13 more — 1:1s, team meetings, reviews, customer calls,
// focus blocks, lunches — often double-booked, now and then an offsite or an early or late
// call. Weekends: 0–3 personal events. The US federal holidays (computed), and a handful of
// observances; a holiday's work day is light. 2025 through 2027.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let seed = 20261013;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const PEOPLE = ["Ana", "Ben", "Chloé", "Dev", "Erin", "Farid", "Grace", "Hiro", "Ines", "Jamal", "Kofi", "Lena", "Marco", "Nadia", "Omar", "Priya", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Vik", "Wen", "Yusuf", "Zoe"];
const TEAMS = ["Platform", "Design", "Growth", "Billing", "Mobile", "Infra", "Search", "Support", "Data", "Security"];
const ROOMS = ["Aspen", "Birch", "Cedar", "Dogwood", "Elm", "Fir", "Ginkgo", "Hazel", "Video call", "Video call", "Video call"];
const WORK = [
  () => [`1:1 with ${pick(PEOPLE)}`, 30],
  () => [`${pick(TEAMS)} sync`, pick([30, 45, 60])],
  () => [`${pick(TEAMS)} planning`, pick([60, 90])],
  () => [`Design review: ${pick(["onboarding", "settings", "checkout", "search results", "dashboard", "notifications"])}`, 60],
  () => [`Customer call — ${pick(["Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark", "Wayne", "Tyrell"])}`, pick([30, 45, 60])],
  () => [`Interview: ${pick(["backend", "frontend", "design", "PM", "data"])} candidate`, pick([45, 60])],
  () => ["Focus time", pick([60, 90, 120])],
  () => [`Lunch with ${pick(PEOPLE)}`, 60],
  () => [rnd() < 0.5 ? `Q${between(1, 4)} roadmap review` : `H${between(1, 2)} roadmap review`, 90],
  () => [`Incident review`, 45],
  () => [`Hiring committee`, 60],
  () => [`Budget check-in`, 30],
  () => [`All hands`, 60],
  () => [`Coffee with ${pick(PEOPLE)}`, 30],
  () => [`Vendor demo`, 45],
];
const PERSONAL = [
  () => ["Groceries", 60], () => ["Gym", 90], () => ["Kids' soccer", 120], () => ["Brunch", 90],
  () => [`Hike — ${pick(["Mt. Tam", "the bluffs", "Rancho", "Skyline"])}`, 240], () => ["Farmers' market", 90],
  () => [`Dinner with ${pick(PEOPLE)}`, 150], () => ["Haircut", 45], () => ["Yoga", 60], () => ["Movie", 150],
  () => [`Birthday party — ${pick(PEOPLE)}`, 180], () => ["Laundry and errands", 120], () => ["Bike ride", 120],
];

// the US federal holidays, and some observances
const nth = (y, m, dow, n) => { const d = new Date(y, m - 1, 1); const first = (dow - d.getDay() + 7) % 7 + 1; return first + (n - 1) * 7; };
const last = (y, m, dow) => { const d = new Date(y, m, 0); return d.getDate() - ((d.getDay() - dow + 7) % 7); };
function holidays(y) {
  return [
    [1, 1, "New Year's Day", "holiday"], [1, nth(y, 1, 1, 3), "Martin Luther King Jr. Day", "holiday"],
    [2, nth(y, 2, 1, 3), "Presidents' Day", "holiday"], [5, last(y, 5, 1), "Memorial Day", "holiday"],
    [6, 19, "Juneteenth", "holiday"], [7, 4, "Independence Day", "holiday"], [9, nth(y, 9, 1, 1), "Labor Day", "holiday"],
    [10, nth(y, 10, 1, 2), "Columbus Day", "holiday"], [11, 11, "Veterans Day", "holiday"],
    [11, nth(y, 11, 4, 4), "Thanksgiving", "holiday"], [12, 25, "Christmas Day", "holiday"],
    [2, 14, "Valentine's Day", "milestone"], [10, 31, "Halloween", "milestone"], [3, 20, "Spring equinox", "astro"],
    [6, 21, "Summer solstice", "astro"], [9, 22, "Autumn equinox", "astro"], [12, 21, "Winter solstice", "astro"],
  ];
}

const events = [];
let id = 1;
const add = (y, m, d, start, len, title, category, extra = {}) => {
  events.push({ id: id++, y, m, d, start, end: Math.min(24 * 60 - 1, start + len), title, category,
    comment: "", notes: extra.notes ?? "", location: extra.location ?? "", attendees: extra.attendees ?? "" });
};

for (let y = 2025; y <= 2027; y++) {
  const hol = new Map(holidays(y).map(([m, d, t, c]) => [`${m}-${d}`, [t, c]]));
  for (let dt = new Date(y, 0, 1); dt.getFullYear() === y; dt.setDate(dt.getDate() + 1)) {
    const m = dt.getMonth() + 1, d = dt.getDate(), dow = dt.getDay();
    const h = hol.get(`${m}-${d}`);
    if (h) add(y, m, d, 9 * 60, 8 * 60, h[0], h[1], { notes: h[1] === "holiday" ? "Office closed." : "" });
    const weekend = dow === 0 || dow === 6;
    const closed = h && h[1] === "holiday";
    if (weekend) {
      for (let k = between(0, 3); k > 0; k--) {
        const [t, len] = pick(PERSONAL)();
        add(y, m, d, between(8, 18) * 60 + pick([0, 30]), len, t, rnd() < 0.15 ? "milestone" : "");
      }
      continue;
    }
    if (closed) continue;
    add(y, m, d, 9 * 60, 15, "Standup", "", { location: "Video call", attendees: TEAMS[dow % TEAMS.length] });
    const n = between(7, 13);
    for (let k = 0; k < n; k++) {
      const [t, len] = pick(WORK)();
      // mostly 9:30–17:30 on the half hour; an early or a late call now and then
      const start = rnd() < 0.08 ? pick([7 * 60 + 30, 8 * 60, 18 * 60, 19 * 60]) : between(19, 35) * 30;
      add(y, m, d, start, len, t, "", {
        location: pick(ROOMS),
        attendees: Array.from({ length: between(1, 6) }, () => pick(PEOPLE)).join(", "),
        notes: rnd() < 0.3 ? pick(["Agenda in the doc.", "Bring the numbers.", "Recorded.", "Prep: read the RFC.", "Decision needed."]) : "",
      });
    }
    if (rnd() < 0.03) add(y, m, d, 9 * 60, 8 * 60, `${pick(TEAMS)} offsite`, "milestone", { location: "Off site" });
  }
}

mkdirSync(path.join(HERE, "data"), { recursive: true });
writeFileSync(path.join(HERE, "data/events.json"), JSON.stringify({ events }));
const perDay = events.length / (3 * 365);
console.log(`${events.length} events, ${perDay.toFixed(1)} a day on average → data/events.json`);
