const app = document.querySelector("#app");
const toastEl = document.querySelector("#toast");
let session = JSON.parse(localStorage.getItem("clue-session") || "null");
let state = null;
let events;
let tab = "create";
let timerTick;
let heartbeat;
let localStream;
const peers = new Map();
const esc = value => String(value ?? "").replace(/[&<>'"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const initials = name => name.split(" ").map(part => part[0]).join("").slice(0, 2).toUpperCase();
const toast = message => { toastEl.textContent = message; toastEl.classList.add("show"); setTimeout(() => toastEl.classList.remove("show"), 2600); };
const api = async (action, data = {}) => {
  const response = await fetch(`/api/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...session, ...data }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
};
const top = roomCode => `<div class="topbar"><div class="brand"><div class="logo"></div>Clue & Guess</div>${roomCode ? `<button class="room-chip" data-copy>ROOM ${esc(roomCode)} · COPY</button>` : ""}</div>`;

function home() {
  clearInterval(timerTick);
  app.innerHTML = `${top()}<section class="hero"><div><div class="kicker">2–8 players · 5 rounds · 1 winner</div><h1>CLUE.<br><span>GUESS.</span><br>WIN.</h1><p class="lede">One secret word. Sixty seconds. Give clever clues, race to guess first, and claim the crown.</p></div><div class="card"><div class="tabs"><button class="tab ${tab === "create" ? "active" : ""}" data-tab="create">Create room</button><button class="tab ${tab === "join" ? "active" : ""}" data-tab="join">Join room</button></div><form class="form" id="entry-form"><div class="field"><label for="name">Your name</label><input class="input" id="name" name="name" maxlength="24" autocomplete="nickname" placeholder="e.g. Monika" required></div>${tab === "join" ? `<div class="field"><label for="code">Room code</label><input class="input" id="code" name="code" maxlength="6" autocomplete="off" placeholder="A1B2C3" required style="text-transform:uppercase"></div>` : ""}<button class="button" type="submit">${tab === "create" ? "Create a room" : "Join the game"}</button><div class="error" id="entry-error"></div></form></div></section>`;
  document.querySelectorAll("[data-tab]").forEach(button => button.onclick = () => { tab = button.dataset.tab; home(); });
  document.querySelector("#entry-form").onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api(tab, values);
      session = { code: result.code, playerId: result.playerId };
      localStorage.setItem("clue-session", JSON.stringify(session));
      state = result.state;
      connect();
      render();
    } catch (problem) { document.querySelector("#entry-error").textContent = problem.message; }
  };
}

function connect() {
  events?.close();
  events = new EventSource(`/api/events?code=${session.code}&playerId=${session.playerId}`);
  events.addEventListener("state", event => { state = JSON.parse(event.data); render(); syncPeers(); });
  events.addEventListener("signal", event => receiveSignal(JSON.parse(event.data)));
  events.onerror = () => toast("Reconnecting…");
  clearInterval(heartbeat);
  heartbeat = setInterval(() => api("heartbeat").catch(problem => {
    if (problem.message === "Session not found") resetSession("Your previous room expired. Create or join a new room.");
  }), 5000);
}

function resetSession(message) {
  clearInterval(heartbeat);
  clearInterval(timerTick);
  events?.close();
  events = null;
  session = null;
  state = null;
  localStorage.removeItem("clue-session");
  home();
  if (message) toast(message);
}

async function restoreSession() {
  if (!session) return home();
  try {
    await api("heartbeat");
    connect();
  } catch {
    resetSession("Your previous room expired. Create or join a new room.");
  }
}

function lobby() {
  const meHost = state.hostId === state.meId;
  app.innerHTML = `${top(state.code)}<section class="lobby"><div class="card"><div class="kicker">Waiting room</div><h2 style="margin-top:20px">Bring the party in</h2><p class="muted">Share room code <b>${esc(state.code)}</b>. The game supports up to 8 players.</p><div class="player-grid">${state.players.map(player => `<div class="player"><div class="avatar">${esc(initials(player.name))}</div><b>${esc(player.name)}</b>${player.id === state.hostId ? `<span class="host-tag">HOST</span>` : ""}</div>`).join("")}</div>${meHost ? `<button class="button pink" data-start ${state.players.length < 2 ? "disabled" : ""}>Start game · ${state.players.length}/8</button>` : `<p><b>Waiting for the host to start…</b></p>`}</div><aside class="card"><h2>Quick rules</h2><div class="rules-mini"><div class="rule"><b>1</b><span>Give clues without using the word, its parts, spelling, or first letter.</span></div><div class="rule"><b>2</b><span>First correct guess gets one point.</span></div><div class="rule"><b>3</b><span>Everyone gives clues once per round.</span></div></div><button class="button secondary" style="margin-top:24px;width:100%" data-mic><span class="mic"><span class="mic-dot"></span>Enable voice chat</span></button></aside></section>`;
  document.querySelector("[data-start]")?.addEventListener("click", () => api("start").catch(problem => toast(problem.message)));
  bindCommon();
}

function game() {
  const current = state.players.find(player => player.id === state.currentId);
  const me = state.players.find(player => player.id === state.meId);
  const giver = state.meId === state.currentId;
  const seconds = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000));
  const roundLabel = state.suddenDeath ? "Sudden death" : `Round ${state.round} / 5`;
  app.innerHTML = `${top(state.code)}<section class="game"><div class="stage"><div class="status-strip"><span class="pill hot">${roundLabel}</span><span class="pill">${esc(current?.name || "Player")} gives clues</span><span class="pill">${state.players.length} players</span></div><div class="card turn-card"><div class="timer" data-timer>${seconds}</div>${giver ? `<div class="secret-label">Your secret word</div><div class="secret">${esc(state.secretWord)}</div><p class="muted">Describe it without saying the word, its parts, spelling, or first letter.</p><div class="actions"><button class="button cyan" data-skip ${state.skipUsed ? "disabled" : ""}>${state.skipUsed ? "Skip used" : "Skip word"}</button><button class="button secondary" data-mic><span class="mic"><span class="mic-dot"></span>Voice chat</span></button></div>` : `<div class="secret-label">Listen closely</div><div class="secret hidden-word">••••••••</div><p class="muted">Type a guess below or say it aloud. You can guess as many times as you like.</p><button class="button secondary" data-mic><span class="mic"><span class="mic-dot"></span>Voice chat</span></button>`}</div><form class="composer" id="play-form"><input class="input" id="play-input" maxlength="80" placeholder="${giver ? "Type a clue…" : "Type your guess…"}" autocomplete="off"><button class="button ${giver ? "cyan" : "pink"}" type="submit">${giver ? "Send clue" : "Guess"}</button></form><div class="feed">${state.guesses.length ? state.guesses.map(item => `<div class="feed-item ${item.type}"><b>${esc(item.name)}:</b> ${esc(item.text)}</div>`).join("") : `<div class="feed-item"><span class="muted">Clues and guesses will appear here.</span></div>`}</div></div><aside class="sidebar"><div class="card"><h2>Scoreboard</h2><div class="score-list">${[...state.players].sort((a,b) => b.score-a.score).map((player,index) => `<div class="score-row ${player.connected ? "" : "offline"}"><div class="avatar">${index+1}</div><div><b>${esc(player.name)}</b><div class="muted">${player.connected ? player.id === state.currentId ? "Clue-giver" : "Playing" : "Reconnecting"}</div></div><div class="score">${player.score}</div></div>`).join("")}</div></div>${giver ? `<div class="card"><h2>Spoken answer?</h2><p class="muted">Tap Correct beside the first player who said it.</p><div class="correct-list">${state.players.filter(player => player.id !== state.meId).map(player => `<div class="correct-row"><b>${esc(player.name)}</b><button class="tiny-button" data-correct="${player.id}">Correct</button></div>`).join("")}</div></div>` : `<div class="card"><b>${esc(state.message)}</b><p class="muted">You have ${me?.score || 0} point${me?.score === 1 ? "" : "s"}.</p></div>`}</aside></section>`;
  document.querySelector("#play-form").onsubmit = async event => {
    event.preventDefault();
    const input = document.querySelector("#play-input");
    if (!input.value.trim()) return;
    try { await api(giver ? "clue" : "guess", { text: input.value }); input.value = ""; input.focus(); } catch (problem) { toast(problem.message); }
  };
  document.querySelector("[data-skip]")?.addEventListener("click", () => api("skip").catch(problem => toast(problem.message)));
  document.querySelectorAll("[data-correct]").forEach(button => button.onclick = () => api("correct", { targetId: button.dataset.correct }).catch(problem => toast(problem.message)));
  bindCommon();
  clearInterval(timerTick);
  timerTick = setInterval(() => { const timer = document.querySelector("[data-timer]"); if (timer && state?.endAt) timer.textContent = Math.max(0, Math.ceil((state.endAt - Date.now()) / 1000)); }, 250);
}

function finished() {
  const names = state.players.filter(player => state.winnerIds.includes(player.id)).map(player => player.name).join(" & ");
  app.innerHTML = `${top(state.code)}<section class="card winner"><div class="crown">👑</div><div class="kicker">Game complete</div><h2>${esc(names)} wins!</h2><p class="lede" style="color:var(--muted);margin:0 auto 28px">Five rounds finished. Final scores are in.</p><div class="score-list" style="max-width:480px;margin:0 auto 28px">${[...state.players].sort((a,b)=>b.score-a.score).map((player,index)=>`<div class="score-row"><div class="avatar">${index+1}</div><b>${esc(player.name)}</b><div class="score">${player.score}</div></div>`).join("")}</div><button class="button" data-home>Back to home</button></section>`;
  document.querySelector("[data-home]").onclick = () => resetSession();
  bindCommon();
}

function render() { if (!state) return home(); if (state.phase === "lobby") return lobby(); if (state.phase === "playing") return game(); return finished(); }
function bindCommon() {
  document.querySelector("[data-copy]")?.addEventListener("click", async () => { await navigator.clipboard.writeText(state.code); toast("Room code copied"); });
  document.querySelectorAll("[data-mic]").forEach(button => button.onclick = toggleMic);
  document.querySelectorAll("[data-mic] .mic").forEach(item => item.classList.toggle("on", Boolean(localStream)));
}
async function toggleMic() {
  try {
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); localStream = null; peers.forEach(peer => peer.close()); peers.clear(); toast("Voice chat off"); }
    else { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); await syncPeers(); toast("Voice chat on"); }
    render();
  } catch { toast("Microphone permission was not granted"); }
}
async function syncPeers() {
  if (!localStream || !state) return;
  for (const player of state.players) {
    if (player.id === state.meId || !player.connected || peers.has(player.id)) continue;
    const polite = state.meId > player.id;
    const peer = makePeer(player.id);
    if (!polite) { const offer = await peer.createOffer(); await peer.setLocalDescription(offer); await api("signal", { targetId: player.id, signal: peer.localDescription }); }
  }
}
function makePeer(targetId) {
  const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  localStream?.getTracks().forEach(track => peer.addTrack(track, localStream));
  peer.onicecandidate = event => event.candidate && api("signal", { targetId, signal: { candidate: event.candidate } }).catch(() => {});
  peer.ontrack = event => { let audio = document.querySelector(`audio[data-peer="${targetId}"]`); if (!audio) { audio = document.createElement("audio"); audio.autoplay = true; audio.dataset.peer = targetId; document.body.append(audio); } audio.srcObject = event.streams[0]; };
  peers.set(targetId, peer);
  return peer;
}
async function receiveSignal({ from, signal }) {
  if (!localStream) return;
  const peer = peers.get(from) || makePeer(from);
  try {
    if (signal.type === "offer") { await peer.setRemoteDescription(signal); const answer = await peer.createAnswer(); await peer.setLocalDescription(answer); await api("signal", { targetId: from, signal: peer.localDescription }); }
    else if (signal.type === "answer") await peer.setRemoteDescription(signal);
    else if (signal.candidate) await peer.addIceCandidate(signal.candidate);
  } catch {}
}
restoreSession();
