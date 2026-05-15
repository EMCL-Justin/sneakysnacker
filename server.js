const express = require("express");
const fs = require("fs");
const path = require("path");

if (process.env.NODE_ENV !== "production") {
  try { require("./env-loader"); } catch {}
}

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || "db.json";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const POLL_INTERVAL_MS = 2 * 60 * 1000;

const BRACKETS = ["2v2", "3v3", "5v5"];

function xunamateUrl(bracket) {
  return `https://anniversary.xunamate.gg/leaderboard/${bracket}/__data.json?region=us&x-sveltekit-invalidated=11`;
}

// ── JSON store ────────────────────────────────────────────────────────────────

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
  return { players: [], snapshots: {}, nextId: 1 };
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let store = loadDb();

// ── Xunamate fetch ────────────────────────────────────────────────────────────

function decodeXunamate(json) {
  const flat = json.nodes[1].data;
  const root = flat[0];
  const entryIndices = flat[root.entries];
  return entryIndices.map((idx) => {
    const e = flat[idx];
    return {
      name: flat[e.name],
      realm: flat[e.realm],
      rating: flat[e.rating],
      rank: flat[e.rank],
      weeklyRatingDelta: flat[e.weeklyRatingDelta] ?? 0,
    };
  });
}

const leaderboardCache = {};

async function fetchLeaderboard(bracket) {
  const res = await fetch(xunamateUrl(bracket), {
    headers: { "User-Agent": "arena-tracker/1.0" },
  });
  if (!res.ok) throw new Error(`Xunamate ${bracket} fetch failed: ${res.status}`);
  const entries = decodeXunamate(await res.json());
  leaderboardCache[bracket] = entries;
  return entries;
}

// ── Discord ───────────────────────────────────────────────────────────────────

function hexToInt(hex) {
  return parseInt(hex.replace("#", ""), 16);
}

async function sendDiscordAlert(player, current, previous) {
  if (!DISCORD_WEBHOOK_URL) return;

  const diff = current.rating - previous.rating;
  const sign = diff >= 0 ? "+" : "";
  const went_up = diff >= 0;

  // Custom color > auto green/red
  const color = player.color
    ? hexToInt(player.color)
    : went_up ? 0x2ecc71 : 0xe74c3c;

  const embed = {
    title: `${player.name} — ${(player.bracket || "3v3").toUpperCase()}`,
    color,
    fields: [
      { name: "Rating", value: `**${current.rating}** (${sign}${diff})`, inline: true },
      { name: "Rank", value: `#${current.rank}`, inline: true },
      { name: "Realm", value: player.realm_slug, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "sneakysnacker" },
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

// ── Polling loop ──────────────────────────────────────────────────────────────

async function poll() {
  try {
    store = loadDb();

    // Only fetch brackets we're actually watching
    const activeBrackets = [...new Set(store.players.map((p) => p.bracket || "3v3"))];
    const results = {};
    for (const bracket of activeBrackets) {
      results[bracket] = await fetchLeaderboard(bracket);
    }

    for (const player of store.players) {
      const bracket = player.bracket || "3v3";
      const entries = results[bracket] ?? [];
      const entry = entries.find(
        (e) =>
          e.name.toLowerCase() === player.name.toLowerCase() &&
          e.realm === player.realm_slug
      );
      if (!entry) continue;

      const snapshotKey = `${player.id}`;
      const prev = store.snapshots[snapshotKey];
      if (prev && prev.rating !== entry.rating) {
        console.log(`Activity: ${player.name} [${bracket}] ${prev.rating} → ${entry.rating}`);
        await sendDiscordAlert(player, entry, prev);
      }

      store.snapshots[snapshotKey] = { ...entry, last_seen: new Date().toISOString() };
    }

    saveDb(store);
    console.log(`Poll done ${new Date().toLocaleTimeString()} — ${store.players.length} watched`);
  } catch (err) {
    console.error("Poll error:", err.message);
  }
}

// ── API routes ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/players", (req, res) => {
  store = loadDb();
  const result = store.players.map((p) => ({ ...p, ...store.snapshots[p.id] }));
  result.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  res.json(result);
});

app.post("/api/players", (req, res) => {
  const { name, realm_slug, bracket = "3v3", color } = req.body;
  if (!name || !realm_slug) return res.status(400).json({ error: "name and realm_slug required" });
  if (!BRACKETS.includes(bracket)) return res.status(400).json({ error: "bracket must be 2v2, 3v3, or 5v5" });
  store = loadDb();
  const exists = store.players.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.realm_slug === realm_slug.toLowerCase() && p.bracket === bracket
  );
  if (exists) return res.status(409).json({ error: "Already watched" });
  const player = {
    id: store.nextId++,
    name: name.trim(),
    realm_slug: realm_slug.trim().toLowerCase(),
    bracket,
    color: color || null,
  };
  store.players.push(player);
  saveDb(store);
  res.json(player);
});

app.patch("/api/players/:id", (req, res) => {
  store = loadDb();
  const id = parseInt(req.params.id);
  const player = store.players.find((p) => p.id === id);
  if (!player) return res.status(404).json({ error: "Not found" });
  if (req.body.color !== undefined) player.color = req.body.color || null;
  saveDb(store);
  res.json(player);
});

app.delete("/api/players/:id", (req, res) => {
  store = loadDb();
  const id = parseInt(req.params.id);
  store.players = store.players.filter((p) => p.id !== id);
  delete store.snapshots[id];
  saveDb(store);
  res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
  store = loadDb();
  res.json({ source: "xunamate", pollIntervalMinutes: POLL_INTERVAL_MS / 60000, watchedCount: store.players.length });
});

app.post("/api/poll", async (req, res) => {
  await poll();
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  poll();
  setInterval(poll, POLL_INTERVAL_MS);
});
