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

const XUNAMATE_URL =
  "https://anniversary.xunamate.gg/leaderboard/3v3/__data.json?region=us&x-sveltekit-invalidated=11";

// ── JSON store ────────────────────────────────────────────────────────────────

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch {}
  return { players: [], snapshots: {}, nextId: 1 };
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let store = loadDb();

// ── Xunamate leaderboard fetch ────────────────────────────────────────────────

// Xunamate uses SvelteKit's deduplication format: a flat array where objects
// store field values as indices into that array rather than inline.
function decodeXunamate(json) {
  const flat = json.nodes[1].data;
  const root = flat[0]; // { meta, entries, season }
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

async function fetchLeaderboard() {
  const res = await fetch(XUNAMATE_URL, {
    headers: { "User-Agent": "arena-tracker/1.0" },
  });
  if (!res.ok) throw new Error(`Xunamate fetch failed: ${res.status}`);
  return decodeXunamate(await res.json());
}

// ── Discord ───────────────────────────────────────────────────────────────────

async function sendDiscordAlert(player, current, previous) {
  if (!DISCORD_WEBHOOK_URL) return;
  const diff = current.rating - previous.rating;
  const sign = diff >= 0 ? "+" : "";
  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content:
        `🏟️ **${player.name}-${player.realm_slug}** just played 3v3\n` +
        `Rating: **${current.rating}** (${sign}${diff}) · Rank #${current.rank}`,
    }),
  });
}

// ── Polling loop ──────────────────────────────────────────────────────────────

async function poll() {
  try {
    const entries = await fetchLeaderboard();
    store = loadDb();

    for (const player of store.players) {
      const entry = entries.find(
        (e) =>
          e.name.toLowerCase() === player.name.toLowerCase() &&
          e.realm === player.realm_slug
      );
      if (!entry) continue;

      const prev = store.snapshots[player.id];
      if (prev && prev.rating !== entry.rating) {
        console.log(`Activity: ${player.name} ${prev.rating} → ${entry.rating}`);
        await sendDiscordAlert(player, entry, prev);
      }

      store.snapshots[player.id] = { ...entry, last_seen: new Date().toISOString() };
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
  const { name, realm_slug } = req.body;
  if (!name || !realm_slug) return res.status(400).json({ error: "name and realm_slug required" });
  store = loadDb();
  const exists = store.players.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.realm_slug === realm_slug.toLowerCase()
  );
  if (exists) return res.status(409).json({ error: "Already watched" });
  const player = { id: store.nextId++, name: name.trim(), realm_slug: realm_slug.trim().toLowerCase() };
  store.players.push(player);
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
