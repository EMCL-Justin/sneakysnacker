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
    };
  });
}

async function fetchAllBrackets() {
  const results = {};
  await Promise.all(
    BRACKETS.map(async (bracket) => {
      const res = await fetch(xunamateUrl(bracket), {
        headers: { "User-Agent": "arena-tracker/1.0" },
      });
      if (!res.ok) throw new Error(`Xunamate ${bracket} fetch failed: ${res.status}`);
      results[bracket] = decodeXunamate(await res.json());
    })
  );
  return results;
}

// ── Discord ───────────────────────────────────────────────────────────────────

function embedConfig(type, bracket) {
  if (type === "avoid") {
    return {
      color: 0xe74c3c,
      title: `⚠️ ${bracket.toUpperCase()} — Be careful queueing!`,
    };
  }
  // target
  if (bracket === "5v5") return { color: 0xf1c40f, title: `🔥 5v5 — GOGOGO queue now!` };
  if (bracket === "3v3") return { color: 0x2ecc71, title: `✅ 3v3 — GOGOGO queue now!` };
  return { color: 0x555555, title: `2v2 — GOGOGO queue now! (low priority)` };
}

async function sendDiscordAlert(player, bracket, current, previous) {
  if (!DISCORD_WEBHOOK_URL) return;

  const diff = current.rating - previous.rating;
  const sign = diff >= 0 ? "+" : "";
  const { color, title } = embedConfig(player.type || "target", bracket);

  const embed = {
    title: `${player.name} — ${title}`,
    color,
    fields: [
      { name: "Rating", value: `**${current.rating}** (${sign}${diff})`, inline: true },
      { name: "Rank", value: `#${current.rank}`, inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: "sneakysnacker" },
  };

  await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: player.ping ? "@here" : undefined, embeds: [embed] }),
  });
}

// ── Polling loop ──────────────────────────────────────────────────────────────

async function poll() {
  try {
    const leaderboards = await fetchAllBrackets();
    store = loadDb();

    for (const player of store.players) {
      for (const bracket of BRACKETS) {
        const entries = leaderboards[bracket];
        const entry = entries.find(
          (e) =>
            e.name.toLowerCase() === player.name.toLowerCase() &&
            e.realm === player.realm_slug
        );
        if (!entry) continue;

        const key = `${player.id}-${bracket}`;
        const prev = store.snapshots[key];

        if (prev && prev.rating !== entry.rating) {
          console.log(`Activity: ${player.name} [${bracket}] ${prev.rating} → ${entry.rating}`);
          const watchedBrackets = player.brackets ?? BRACKETS;
          if (watchedBrackets.includes(bracket)) {
            await sendDiscordAlert(player, bracket, entry, prev);
          }
        }

        store.snapshots[key] = { ...entry, last_seen: new Date().toISOString() };
      }
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
  const result = store.players.map((p) => {
    const bracketData = {};
    for (const b of BRACKETS) {
      const snap = store.snapshots[`${p.id}-${b}`];
      if (snap) bracketData[b] = snap;
    }
    // Most recently active bracket
    const recent = Object.values(bracketData).sort((a, b) => new Date(b.last_seen) - new Date(a.last_seen))[0];
    return { ...p, bracketData, rating: recent?.rating, rank: recent?.rank, last_seen: recent?.last_seen };
  });
  result.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  res.json(result);
});

app.post("/api/players", (req, res) => {
  const { name, type = "target", brackets = ["2v2", "3v3", "5v5"] } = req.body;
  const realm_slug = "nightslayer";
  if (!name) return res.status(400).json({ error: "name required" });
  if (!["target", "avoid"].includes(type)) return res.status(400).json({ error: "type must be target or avoid" });
  const validBrackets = brackets.filter(b => BRACKETS.includes(b));
  if (!validBrackets.length) return res.status(400).json({ error: "at least one valid bracket required" });
  store = loadDb();
  const exists = store.players.find(
    (p) => p.name.toLowerCase() === name.toLowerCase() && p.realm_slug === realm_slug.toLowerCase()
  );
  if (exists) return res.status(409).json({ error: "Already watched" });
  const player = { id: store.nextId++, name: name.trim(), realm_slug, type, brackets: validBrackets, ping: false };
  store.players.push(player);
  saveDb(store);
  res.json(player);
});

app.patch("/api/players/:id", (req, res) => {
  store = loadDb();
  const id = parseInt(req.params.id);
  const player = store.players.find((p) => p.id === id);
  if (!player) return res.status(404).json({ error: "Not found" });
  if (req.body.ping !== undefined) player.ping = !!req.body.ping;
  if (req.body.brackets !== undefined) {
    const valid = req.body.brackets.filter(b => BRACKETS.includes(b));
    if (valid.length) player.brackets = valid;
  }
  saveDb(store);
  res.json(player);
});

app.delete("/api/players/:id", (req, res) => {
  store = loadDb();
  const id = parseInt(req.params.id);
  store.players = store.players.filter((p) => p.id !== id);
  for (const b of BRACKETS) delete store.snapshots[`${id}-${b}`];
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
