import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomBytes } from "node:crypto";

const port = Number(process.env.PORT || 3000);
const rooms = new Map();
const words = ["rainbow", "backpack", "popcorn", "dolphin", "library", "volcano", "pancake", "telescope", "whisper", "snowman", "airport", "treasure", "calendar", "sandwich", "bicycle", "firework", "penguin", "blanket", "camera", "jungle", "football", "chocolate", "mountain", "umbrella", "keyboard", "butterfly", "hospital", "birthday", "pirate", "elephant"];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const id = (n = 8) => randomBytes(n).toString("hex");
const code = () => { let value; do value = randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(value)); return value; };
const clean = value => String(value || "").trim().replace(/\s+/g, " ").slice(0, 80);
const normalize = value => clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
const playerList = room => room.order.map(playerId => room.players.get(playerId)).filter(Boolean);
const publicState = (room, playerId) => {
  const currentId = room.turnOrder[room.turnIndex] || null;
  return { code: room.code, phase: room.phase, round: room.round, maxRounds: 5, hostId: room.hostId, meId: playerId, currentId, endAt: room.endAt, skipUsed: room.skipUsed, secretWord: currentId === playerId ? room.secretWord : null, winnerIds: room.winnerIds, suddenDeath: room.suddenDeath, message: room.message, guesses: room.guesses.slice(-18), players: playerList(room).map(player => ({ id: player.id, name: player.name, score: player.score, connected: player.connected })) };
};
const send = (res, status, data) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(data)); };
const body = req => new Promise((resolve, reject) => { let raw = ""; req.on("data", chunk => raw += chunk); req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } }); });
const broadcast = room => { for (const [playerId, clients] of room.clients) { const payload = `event: state\ndata: ${JSON.stringify(publicState(room, playerId))}\n\n`; for (const client of clients) client.write(payload); } };
const chooseWord = room => { const available = words.filter(word => !room.usedWords.has(word)); if (!available.length) room.usedWords.clear(); const pool = available.length ? available : words; const selected = pool[Math.floor(Math.random() * pool.length)]; room.usedWords.add(selected); return selected; };
const clearTimers = room => { clearTimeout(room.turnTimer); clearTimeout(room.waitTimer); room.turnTimer = null; room.waitTimer = null; };
const beginTurn = room => {
  clearTimers(room);
  if (room.phase !== "playing") return;
  const current = room.players.get(room.turnOrder[room.turnIndex]);
  room.guesses = [];
  room.skipUsed = false;
  room.secretWord = chooseWord(room);
  room.message = current?.connected ? `${current.name} is giving clues` : `Waiting for ${current?.name || "player"} to reconnect`;
  if (!current?.connected) { room.endAt = Date.now() + 30000; room.waitTimer = setTimeout(() => advance(room, "Turn skipped — player did not reconnect"), 30000); }
  else { room.endAt = Date.now() + 60000; room.turnTimer = setTimeout(() => advance(room, "Time's up — no point awarded"), 60000); }
  broadcast(room);
};
const finishRegularGame = room => {
  const highest = Math.max(...playerList(room).map(player => player.score));
  const tied = playerList(room).filter(player => player.score === highest);
  if (tied.length === 1) { room.phase = "finished"; room.winnerIds = [tied[0].id]; room.message = `${tied[0].name} wins!`; room.endAt = null; broadcast(room); return; }
  room.suddenDeath = true;
  room.turnOrder = tied.map(player => player.id);
  room.turnIndex = 0;
  room.round = null;
  room.message = "Sudden death! First tied player to score wins.";
  beginTurn(room);
};
const advance = (room, message = "Next turn") => {
  clearTimers(room);
  if (room.phase !== "playing") return;
  room.message = message;
  room.turnIndex += 1;
  if (room.turnIndex >= room.turnOrder.length) { room.turnIndex = 0; if (!room.suddenDeath) { room.round += 1; if (room.round > 5) return finishRegularGame(room); } }
  beginTurn(room);
};
const createRoom = name => {
  const playerId = id();
  const roomCode = code();
  const player = { id: playerId, name, score: 0, connected: true, lastSeen: Date.now() };
  const room = { code: roomCode, phase: "lobby", players: new Map([[playerId, player]]), order: [playerId], hostId: playerId, clients: new Map(), turnOrder: [], turnIndex: 0, round: 1, endAt: null, skipUsed: false, secretWord: null, winnerIds: [], suddenDeath: false, message: "Waiting for players", guesses: [], usedWords: new Set(), turnTimer: null, waitTimer: null };
  rooms.set(roomCode, room);
  return { room, playerId };
};
const sessionFor = data => { const room = rooms.get(String(data.code || "").toUpperCase()); return { room, player: room?.players.get(data.playerId) }; };
const action = async (req, res, kind) => {
  const data = await body(req);
  if (kind === "create") {
    const name = clean(data.name).slice(0, 24);
    if (!name) return send(res, 400, { error: "Enter your name" });
    const result = createRoom(name);
    return send(res, 200, { code: result.room.code, playerId: result.playerId, state: publicState(result.room, result.playerId) });
  }
  if (kind === "join") {
    const room = rooms.get(String(data.code || "").toUpperCase());
    const name = clean(data.name).slice(0, 24);
    if (!room) return send(res, 404, { error: "Room not found" });
    if (room.phase !== "lobby") return send(res, 409, { error: "This game has already started" });
    if (room.players.size >= 8) return send(res, 409, { error: "This room is full" });
    if (!name) return send(res, 400, { error: "Enter your name" });
    const playerId = id();
    room.players.set(playerId, { id: playerId, name, score: 0, connected: true, lastSeen: Date.now() });
    room.order.push(playerId);
    broadcast(room);
    return send(res, 200, { code: room.code, playerId, state: publicState(room, playerId) });
  }
  const { room, player } = sessionFor(data);
  if (!room || !player) return send(res, 404, { error: "Session not found" });
  player.connected = true;
  player.lastSeen = Date.now();
  if (kind === "heartbeat") { if (room.phase === "playing" && room.turnOrder[room.turnIndex] === player.id && room.waitTimer) beginTurn(room); return send(res, 200, { ok: true }); }
  if (kind === "start") {
    if (room.hostId !== player.id) return send(res, 403, { error: "Only the host can start" });
    if (room.players.size < 2) return send(res, 409, { error: "At least 2 players are needed" });
    room.phase = "playing"; room.turnOrder = [...room.order].sort(() => Math.random() - .5); room.turnIndex = 0; room.round = 1; room.suddenDeath = false; beginTurn(room);
    return send(res, 200, { ok: true });
  }
  if (room.phase !== "playing") return send(res, 409, { error: "The game is not active" });
  const currentId = room.turnOrder[room.turnIndex];
  if (kind === "clue") {
    if (player.id !== currentId) return send(res, 403, { error: "Only the clue-giver can send clues" });
    const value = clean(data.text);
    if (!value) return send(res, 400, { error: "Enter a clue" });
    const forbidden = normalize(room.secretWord);
    const clue = normalize(value);
    if (clue.includes(forbidden) || (forbidden.includes(clue) && clue.length > 2)) { advance(room, "Forbidden clue used — no point awarded"); return send(res, 200, { violation: true }); }
    room.guesses.push({ id: id(4), playerId: player.id, name: player.name, text: value, type: "clue" }); broadcast(room); return send(res, 200, { ok: true });
  }
  if (kind === "guess") {
    if (player.id === currentId) return send(res, 403, { error: "The clue-giver cannot guess" });
    const value = clean(data.text);
    if (!value) return send(res, 400, { error: "Enter a guess" });
    if (normalize(value) === normalize(room.secretWord)) {
      player.score += 1;
      if (room.suddenDeath) { clearTimers(room); room.phase = "finished"; room.winnerIds = [player.id]; room.endAt = null; room.message = `${player.name} wins sudden death!`; broadcast(room); }
      else advance(room, `${player.name} guessed ${room.secretWord} and scored!`);
      return send(res, 200, { correct: true });
    }
    room.guesses.push({ id: id(4), playerId: player.id, name: player.name, text: value, type: "guess" }); broadcast(room); return send(res, 200, { correct: false });
  }
  if (kind === "skip") {
    if (player.id !== currentId) return send(res, 403, { error: "Only the clue-giver can skip" });
    if (room.skipUsed) return send(res, 409, { error: "Your skip is already used" });
    room.skipUsed = true; room.secretWord = chooseWord(room); room.guesses = []; room.message = `${player.name} skipped to a new word`; broadcast(room); return send(res, 200, { ok: true });
  }
  if (kind === "correct") {
    if (player.id !== currentId) return send(res, 403, { error: "Only the clue-giver can confirm" });
    const winner = room.players.get(data.targetId);
    if (!winner || winner.id === currentId) return send(res, 400, { error: "Choose a valid guesser" });
    winner.score += 1;
    if (room.suddenDeath) { clearTimers(room); room.phase = "finished"; room.winnerIds = [winner.id]; room.endAt = null; room.message = `${winner.name} wins sudden death!`; broadcast(room); }
    else advance(room, `${winner.name} gave the first correct spoken guess!`);
    return send(res, 200, { ok: true });
  }
  if (kind === "signal") { const clients = room.clients.get(data.targetId) || []; const payload = `event: signal\ndata: ${JSON.stringify({ from: player.id, signal: data.signal })}\n\n`; for (const client of clients) client.write(payload); return send(res, 200, { ok: true }); }
  send(res, 404, { error: "Unknown action" });
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname.startsWith("/api/")) return await action(req, res, url.pathname.slice(5));
    if (req.method === "GET" && url.pathname === "/api/events") {
      const room = rooms.get(String(url.searchParams.get("code") || "").toUpperCase());
      const playerId = url.searchParams.get("playerId");
      const player = room?.players.get(playerId);
      if (!room || !player) return send(res, 404, { error: "Session not found" });
      player.connected = true; player.lastSeen = Date.now();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      if (!room.clients.has(playerId)) room.clients.set(playerId, new Set());
      room.clients.get(playerId).add(res);
      res.write(`event: state\ndata: ${JSON.stringify(publicState(room, playerId))}\n\n`);
      req.on("close", () => room.clients.get(playerId)?.delete(res));
      return;
    }
    const path = (url.pathname === "/" ? "/index.html" : url.pathname).replace(/\.\./g, "");
    try { const file = await readFile(join(process.cwd(), "public", path)); res.writeHead(200, { "content-type": types[extname(path)] || "application/octet-stream", "cache-control": "no-store" }); res.end(file); }
    catch { res.writeHead(404); res.end("Not found"); }
  } catch (error) { send(res, 500, { error: error.message }); }
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    for (const player of room.players.values()) { const connected = now - player.lastSeen < 12000; if (player.connected !== connected) { player.connected = connected; changed = true; } }
    if (!room.players.get(room.hostId)?.connected) { const nextHost = playerList(room).find(player => player.connected); if (nextHost && room.hostId !== nextHost.id) { room.hostId = nextHost.id; changed = true; } }
    if (changed) broadcast(room);
  }
}, 4000);

server.listen(port, "0.0.0.0", () => console.log(`Clue & Guess is ready at http://localhost:${port}`));
