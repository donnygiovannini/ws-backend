import { WebSocketServer } from "ws";
import { parse } from "url";
import { randomUUID } from "crypto";
import { createServer } from "http";
import { createDeck, addCards, updateCard, removeCard, setDraft, validateDeckForGame } from "./deck.js";

const PORT = process.env.PORT || 8081;
const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ status: "ok" }));
  }
  res.writeHead(404);
  res.end("Not found");
});
const wss = new WebSocketServer({ server, maxPayload: 65536 });
server.listen(PORT, "0.0.0.0", () => console.log(`✅ [SERVER] WebSocket server is running on ws://localhost:${server.address().port}`));
const rooms = new Map();

const MAX_ROUNDS = 10;
const COLOR_POOL = ["#FF0000", "#0000FF", "#008000", "#FFFF00", "#FFA500", "#800080", "#FF00FF", "#00FFFF", "#A52A2A", "#FFC0CB", "#808080", "#008080", "#800000", "#F0E68C"];
const EMOTIONS_POOL = ["cameleon.png", "dog.png", "elephant.png", "fox.png", "hedgehog.png", "octopus.png", "peacock.png", "rooster.png", "squirel.png", "turtle.png", "dog_2.png", "coala.png", "mercat.png", "penguin.png"];
const WORDS_POOL = ["Apple", "House", "Star", "River", "Cloud", "Bridge", "Forest", "Ocean", "Moon", "Sun", "Key", "Book", "Chair", "Door", "Floor", "Ghost", "Heart", "Light", "Magic", "Night", "Paper", "Queen", "Rock", "Ship", "Time", "Vibes", "Water", "Yacht", "Zen", "Map"];
const NUMBERS_POOL = Array.from({ length: 100 }, (_, i) => i.toString());
const GAME_TYPES = new Set(["colors", "emotions", "random_words", "numbers", "custom_cards"]);

function send(ws, type, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
}
function isMember(room, ws) {
  return room.lobby.includes(ws) || Object.values(room.gameState?.players || {}).some((player) => player.ws === ws);
}
function deckSnapshot(room) {
  return { ...room.deck, editable: !room.gameState || room.gameState.isGameOver };
}
function broadcastDeck(roomId) {
  broadcastToRoom(roomId, { type: "DECK_STATE", payload: deckSnapshot(rooms.get(roomId)) });
}
function scheduleCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room || getRoomSockets(roomId).some((ws) => ws.readyState === 1)) return;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    if (!getRoomSockets(roomId).some((ws) => ws.readyState === 1)) rooms.delete(roomId);
  }, 30 * 60 * 1000);
  room.cleanupTimer.unref();
}
function sendRound(ws, gameState, player) {
  if (gameState.isGameOver) return send(ws, "GAME_OVER", { finalScore: gameState.score });
  if (!gameState.currentRoundData) return;
  const { correctItem, options } = gameState.currentRoundData;
  send(ws, "NEW_ROUND", { round: gameState.round, score: gameState.score, sender: player.role === "sender" ? { correctItem } : null, receiver: player.role === "receiver" ? { options } : null });
  if (gameState.roundResult) send(ws, "GUESS_RESULT", gameState.roundResult);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function getRoomSockets(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData) return [];
  return roomData.gameState
    ? Object.values(roomData.gameState.players)
        .map((p) => p.ws)
        .filter(Boolean)
    : roomData.lobby;
}
function broadcastToRoom(roomId, message) {
  for (const client of getRoomSockets(roomId)) {
    if (client?.readyState === 1) client.send(JSON.stringify(message));
  }
}

function startNewRound(roomId) {
  const roomData = rooms.get(roomId);
  if (!roomData?.gameState) return;
  const { gameState } = roomData;
  if (gameState.isGameOver) return;
  gameState.round++;
  if (gameState.round > MAX_ROUNDS) {
    gameState.isGameOver = true;
    broadcastDeck(roomId);
    return broadcastToRoom(roomId, { type: "GAME_OVER", payload: { finalScore: gameState.score } });
  }

  // --- MODIFIED: Select the correct pool based on gameType ---
  let itemPool = [];
  switch (gameState.gameType) {
    case "colors":
      itemPool = COLOR_POOL;
      break;
    case "emotions":
      itemPool = EMOTIONS_POOL;
      break;
    case "random_words":
      itemPool = WORDS_POOL;
      break;
    case "numbers":
      itemPool = NUMBERS_POOL;
      break;
    case "custom_cards":
      itemPool = gameState.customCards;
      break;
    default:
      itemPool = COLOR_POOL; // Default to colors
  }

  const newPool = itemPool.filter((item) => item !== gameState.lastCorrectItem);
  const correctItem = shuffleArray([...newPool])[0];
  const distractorPool = itemPool.filter((item) => item !== correctItem && item !== gameState.lastCorrectItem);
  const distractors = shuffleArray([...distractorPool]).slice(0, 3);
  const options = shuffleArray([correctItem, ...distractors]);

  gameState.lastCorrectItem = correctItem;
  gameState.currentRoundData = { correctItem, options };
  gameState.roundResult = null;
  gameState.readyForNextRound = new Set();

  for (const playerId in gameState.players) {
    const player = gameState.players[playerId];
    if (player.ws) {
      const payload = { round: gameState.round, score: gameState.score, sender: player.role === "sender" ? { correctItem } : null, receiver: player.role === "receiver" ? { options } : null };
      player.ws.send(JSON.stringify({ type: "NEW_ROUND", payload }));
    }
  }
}

function restartGame(roomId, { switchRoles = false, gameType = null, initiatorPlayerId = null, initiatorRole = null } = {}) {
  const roomData = rooms.get(roomId);
  if (!roomData?.gameState?.isGameOver) return;
  const { gameState } = roomData;

  if (!Object.values(gameState.players).every((player) => player.ws?.readyState === 1)) return;
  if (gameType === "custom_cards") gameState.customCards = validateDeckForGame(roomData.deck);

  if (gameType && initiatorPlayerId && initiatorRole && gameState.players[initiatorPlayerId]) {
    gameState.gameType = gameType;
    gameState.players[initiatorPlayerId].role = initiatorRole;
    for (const [playerId, player] of Object.entries(gameState.players)) {
      if (playerId !== initiatorPlayerId) player.role = initiatorRole === "sender" ? "receiver" : "sender";
    }
  } else if (switchRoles) {
    for (const player of Object.values(gameState.players)) {
      player.role = player.role === "sender" ? "receiver" : "sender";
    }
  }

  gameState.score = 0;
  gameState.round = 0;
  gameState.lastCorrectItem = null;
  gameState.currentRoundData = null;
  gameState.roundResult = null;
  gameState.readyForNextRound = new Set();
  gameState.readyPlayers = new Set();
  gameState.isGameOver = false;
  roomData.deck.drafts = {};
  broadcastDeck(roomId);

  for (const [playerId, player] of Object.entries(gameState.players)) {
    if (player.ws?.readyState === 1) {
      player.ws.send(JSON.stringify({ type: "GAME_RESTARTED", payload: { roomId, gameType: gameState.gameType, role: player.role, playerId } }));
    }
  }
}

wss.on("connection", (ws, req) => {
  const { pathname } = parse(req.url);
  const roomId = pathname.substring(1);
  if (!roomId) return ws.close();
  if (!rooms.has(roomId)) rooms.set(roomId, { lobby: [], gameState: null, deck: createDeck() });
  const roomData = rooms.get(roomId);
  clearTimeout(roomData.cleanupTimer);
  ws.roomId = roomId;
  ws.on("error", () => {});

  ws.on("message", (message) => {
    let parsed;
    try { parsed = JSON.parse(message); } catch { return send(ws, "ERROR", { message: "Invalid message." }); }
    if (!parsed || typeof parsed.type !== "string") return;
    const { type, payload = {} } = parsed;
    const { lobby } = roomData;
    const gameState = roomData.gameState;
    try {
    if (type.startsWith("DECK_")) {
      if (!isMember(roomData, ws)) throw new Error("Connect to this room before editing its deck.");
      if (type === "DECK_GET") return send(ws, "DECK_STATE", deckSnapshot(roomData));
      if (gameState && !gameState.isGameOver) throw new Error("The deck is locked while a game is in progress.");
      let result = {};
      switch (type) {
        case "DECK_DRAFT": setDraft(roomData.deck, ws.actorId, payload); break;
        case "DECK_ADD":
          result = addCards(roomData.deck, payload.cards);
          if (payload.clearDraft) delete roomData.deck.drafts[ws.actorId];
          break;
        case "DECK_UPDATE":
          updateCard(roomData.deck, payload, ws.actorId);
          delete roomData.deck.drafts[ws.actorId];
          break;
        case "DECK_REMOVE": removeCard(roomData.deck, payload, ws.actorId); break;
        default: return;
      }
      broadcastDeck(roomId);
      if (type !== "DECK_DRAFT") send(ws, "DECK_ACK", { requestId: payload.requestId, ...result });
      return;
    }
    switch (type) {
      case "IDENTIFY_LOBBY":
        if (isMember(roomData, ws)) return;
        ws.clientId = typeof payload.clientId === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(payload.clientId) ? payload.clientId : randomUUID();
        const resumed = Object.entries(gameState?.players || {}).find(([, player]) => player.clientId === ws.clientId);
        if (resumed) {
          const [id, player] = resumed;
          const previous = player.ws;
          player.ws = ws;
          ws.playerId = id;
          ws.actorId = player.actorId;
          clearTimeout(player.disconnectTimer);
          if (previous && previous !== ws) previous.close();
          send(ws, "ROOM_IDENTITY", { actorId: ws.actorId });
          send(ws, "SESSION_SYNC", { roomId, playerId: id, role: player.role, gameType: gameState.gameType });
          send(ws, "DECK_STATE", deckSnapshot(roomData));
          broadcastToRoom(roomId, { type: "ROOM_UPDATE", count: getRoomSockets(roomId).filter((socket) => socket.readyState === 1).length });
          if (!gameState.isGameOver) send(ws, "GAME_STARTED", { roomId, playerId: id, role: player.role, gameType: gameState.gameType });
          break;
        }
        if (gameState) throw new Error("This room already has a game. Use a new connect code.");
        const previousLobby = lobby.find((socket) => socket.clientId === ws.clientId);
        ws.actorId = previousLobby?.actorId ?? randomUUID();
        if (previousLobby) {
          lobby.splice(lobby.indexOf(previousLobby), 1);
          previousLobby.close();
        }
        if (lobby.length >= 2) throw new Error("This room already has two players.");
        ws.id = ws.clientId;
        lobby.push(ws);
        send(ws, "ROOM_IDENTITY", { actorId: ws.actorId });
        send(ws, "DECK_STATE", deckSnapshot(roomData));
        broadcastToRoom(roomId, { type: "ROOM_UPDATE", count: lobby.length });
        break;
      case "START_GAME":
        if (!isMember(roomData, ws)) throw new Error("Connect to the room first.");
        if (!GAME_TYPES.has(payload.gameType) || !["sender", "receiver"].includes(payload.role)) throw new Error("Choose a valid game and role.");
        if (getRoomSockets(roomId).filter((socket) => socket.readyState === 1).length !== 2) throw new Error("Connect a second player before starting.");
        if (gameState) {
          if (!gameState.isGameOver || !gameState.players[ws.playerId]) return;
          restartGame(roomId, { gameType: payload.gameType, initiatorPlayerId: ws.playerId, initiatorRole: payload.role });
          break;
        }
        if (lobby.length !== 2) return;
        const initiator = ws;
        const otherPlayer = lobby.find((p) => p.id !== initiator.id);
        if (!otherPlayer) return;
        const initiatorPlayerId = randomUUID();
        const otherPlayerId = randomUUID();
        const { gameType, role: initiatorRole } = payload;
        const customCards = gameType === "custom_cards" ? validateDeckForGame(roomData.deck) : null;
        const otherPlayerRole = initiatorRole === "sender" ? "receiver" : "sender";
        roomData.gameState = {
          gameType,
          customCards,
          players: {
            [initiatorPlayerId]: { role: initiatorRole, ws: initiator, clientId: initiator.clientId, actorId: initiator.actorId },
            [otherPlayerId]: { role: otherPlayerRole, ws: otherPlayer, clientId: otherPlayer.clientId, actorId: otherPlayer.actorId },
          },
          score: 0,
          round: 0,
          lastCorrectItem: null,
          readyPlayers: new Set(),
          isGameOver: false,
        };
        roomData.lobby = [];
        initiator.playerId = initiatorPlayerId;
        otherPlayer.playerId = otherPlayerId;
        roomData.deck.drafts = {};
        broadcastDeck(roomId);
        initiator.send(JSON.stringify({ type: "GAME_STARTED", payload: { roomId, gameType, role: initiatorRole, playerId: initiatorPlayerId } }));
        otherPlayer.send(JSON.stringify({ type: "GAME_STARTED", payload: { roomId, gameType, role: otherPlayerRole, playerId: otherPlayerId } }));
        break;
      case "PLAYER_READY":
        if (!gameState) return;
        const { playerId } = payload;
        if (gameState.players[playerId]) {
          const player = gameState.players[playerId];
          const previous = player.ws;
          const needsSnapshot = previous !== ws || payload.resume === true;
          clearTimeout(player.disconnectTimer);
          player.ws = ws;
          ws.clientId = player.clientId;
          ws.actorId = player.actorId;
          ws.playerId = playerId;
          if (previous && previous !== ws) previous.close();
          gameState.readyPlayers.add(playerId);
          send(ws, "ROOM_IDENTITY", { actorId: ws.actorId });
          send(ws, "DECK_STATE", deckSnapshot(roomData));
          broadcastToRoom(roomId, { type: "ROOM_UPDATE", count: getRoomSockets(roomId).filter((socket) => socket.readyState === 1).length });
          if (needsSnapshot && gameState.round > 0) sendRound(ws, gameState, player);
        }
        // Route changes can cause a client to identify itself more than once.
        // Only the transition into a fresh game's first round should start it.
        if (gameState.readyPlayers.size === 2 && gameState.round === 0) startNewRound(roomId);
        break;
      case "SUBMIT_GUESS":
        if (!gameState?.currentRoundData || gameState.isGameOver || gameState.roundResult || gameState.players[ws.playerId]?.ws !== ws || gameState.players[ws.playerId]?.role !== "receiver" || !gameState.currentRoundData.options.includes(payload.item)) return;
        const { correctItem } = gameState.currentRoundData;
        const isCorrect = payload.item === correctItem;
        if (isCorrect) gameState.score++;
        gameState.roundResult = { result: isCorrect ? "Correct" : "Wrong", score: gameState.score, pickedItem: payload.item, correctItem };
        broadcastToRoom(roomId, { type: "GUESS_RESULT", payload: gameState.roundResult });
        break;
      case "REQUEST_NEXT_ROUND":
        if (!gameState || gameState.isGameOver || !gameState.roundResult || gameState.players[ws.playerId]?.ws !== ws) return;
        if (ws.playerId) gameState.readyForNextRound.add(ws.playerId);
        if (gameState.readyForNextRound.size === 2) startNewRound(roomId);
        break;
      case "REQUEST_REMATCH":
        if (gameState?.players[ws.playerId]?.ws !== ws) return;
        restartGame(roomId, { switchRoles: Boolean(payload?.switchRoles) });
        break;
    }
    } catch (error) {
      send(ws, type.startsWith("DECK_") ? "DECK_ERROR" : "ERROR", { requestId: payload?.requestId, message: error.message });
    }
  });

  ws.on("close", () => {
    const roomData = rooms.get(ws.roomId);
    if (!roomData) return;
    const replaced = getRoomSockets(ws.roomId).some((socket) => socket !== ws && socket.clientId === ws.clientId && socket.readyState === 1);
    if (!replaced && roomData.deck.drafts[ws.actorId]) {
      delete roomData.deck.drafts[ws.actorId];
      broadcastDeck(ws.roomId);
    }
    if (ws.playerId && roomData.gameState?.players[ws.playerId]) {
      const player = roomData.gameState.players[ws.playerId];
      if (player.ws !== ws) return;
      player.ws = null;
      broadcastToRoom(ws.roomId, { type: "ROOM_UPDATE", count: getRoomSockets(ws.roomId).filter((socket) => socket.readyState === 1).length });
      clearTimeout(player.disconnectTimer);
      player.disconnectTimer = setTimeout(() => {
        if (player.ws) return;
        const allPlayersDisconnected = Object.values(roomData.gameState.players).every((roomPlayer) => roomPlayer.ws === null);
        if (allPlayersDisconnected) {
          scheduleCleanup(ws.roomId);
        } else {
          broadcastToRoom(ws.roomId, { type: "PLAYER_DISCONNECTED" });
        }
      }, 5000);
    } else {
      roomData.lobby = roomData.lobby.filter((p) => p !== ws);
      broadcastToRoom(ws.roomId, { type: "ROOM_UPDATE", count: roomData.lobby.length });
      scheduleCleanup(ws.roomId);
    }
  });
});
