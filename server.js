import { WebSocketServer } from "ws";
import { parse } from "url";
import { randomUUID } from "crypto";

const PORT = process.env.PORT || 8081;
const wss = new WebSocketServer({ port: PORT });
const rooms = new Map();
console.log(`✅ [SERVER] WebSocket server is running on ws://localhost:${PORT}`);

const MAX_ROUNDS = 10;
const COLOR_POOL = ["#FF0000", "#0000FF", "#008000", "#FFFF00", "#FFA500", "#800080", "#FF00FF", "#00FFFF", "#A52A2A", "#FFC0CB", "#808080", "#008080", "#800000", "#F0E68C"];
const EMOTIONS_POOL = ["cameleon.png", "dog.png", "elephant.png", "fox.png", "hedgehog.png", "octopus.png", "peacock.png", "rooster.png", "squirel.png", "turtle.png", "dog_2.png", "coala.png", "mercat.png", "penguin.png"];
const WORDS_POOL = ["Apple", "House", "Star", "River", "Cloud", "Bridge", "Forest", "Ocean", "Moon", "Sun", "Key", "Book", "Chair", "Door", "Floor", "Ghost", "Heart", "Light", "Magic", "Night", "Paper", "Queen", "Rock", "Ship", "Time", "Vibes", "Water", "Yacht", "Zen", "Map"];
const NUMBERS_POOL = Array.from({ length: 100 }, (_, i) => i.toString());

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
  gameState.round++;
  if (gameState.round > MAX_ROUNDS) {
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
  gameState.readyForNextRound = new Set();

  for (const playerId in gameState.players) {
    const player = gameState.players[playerId];
    if (player.ws) {
      const payload = { round: gameState.round, score: gameState.score, sender: player.role === "sender" ? { correctItem } : null, receiver: player.role === "receiver" ? { options } : null };
      player.ws.send(JSON.stringify({ type: "NEW_ROUND", payload }));
    }
  }
}

wss.on("connection", (ws, req) => {
  const { pathname } = parse(req.url);
  const roomId = pathname.substring(1);
  if (!roomId) return ws.close();
  if (!rooms.has(roomId)) rooms.set(roomId, { lobby: [], gameState: null });
  const roomData = rooms.get(roomId);
  ws.roomId = roomId;

  ws.on("message", (message) => {
    const { type, payload } = JSON.parse(message);
    const { lobby } = roomData;
    const gameState = roomData.gameState;
    switch (type) {
      case "IDENTIFY_LOBBY":
        ws.id = randomUUID();
        if (lobby.length < 2) lobby.push(ws);
        broadcastToRoom(roomId, { type: "ROOM_UPDATE", count: lobby.length });
        break;
      case "START_GAME":
        if (gameState || lobby.length !== 2) return;
        const initiator = ws;
        const otherPlayer = lobby.find((p) => p.id !== initiator.id);
        if (!otherPlayer) return;
        const initiatorPlayerId = randomUUID();
        const otherPlayerId = randomUUID();
        const { gameType, role: initiatorRole } = payload;
        const otherPlayerRole = initiatorRole === "sender" ? "receiver" : "sender";
        roomData.gameState = {
          gameType,
          players: {
            [initiatorPlayerId]: { role: initiatorRole, ws: initiator },
            [otherPlayerId]: { role: otherPlayerRole, ws: otherPlayer },
          },
          score: 0,
          round: 0,
          lastCorrectItem: null,
          readyPlayers: new Set(),
        };
        roomData.lobby = [];
        initiator.send(JSON.stringify({ type: "GAME_STARTED", payload: { roomId, gameType, role: initiatorRole, playerId: initiatorPlayerId } }));
        otherPlayer.send(JSON.stringify({ type: "GAME_STARTED", payload: { roomId, gameType, role: otherPlayerRole, playerId: otherPlayerId } }));
        break;
      case "PLAYER_READY":
        if (!gameState) return;
        const { playerId } = payload;
        if (gameState.players[playerId]) {
          gameState.players[playerId].ws = ws;
          ws.playerId = playerId;
          gameState.readyPlayers.add(playerId);
        }
        if (gameState.readyPlayers.size === 2) startNewRound(roomId);
        break;
      case "SUBMIT_GUESS":
        if (!gameState?.currentRoundData) return;
        const { correctItem } = gameState.currentRoundData;
        const isCorrect = payload.item === correctItem;
        if (isCorrect) gameState.score++;
        broadcastToRoom(roomId, { type: "GUESS_RESULT", payload: { result: isCorrect ? "Correct" : "Wrong", score: gameState.score, pickedItem: payload.item, correctItem } });
        break;
      case "REQUEST_NEXT_ROUND":
        if (!gameState) return;
        if (ws.playerId) gameState.readyForNextRound.add(ws.playerId);
        if (gameState.readyForNextRound.size === 2) startNewRound(roomId);
        break;
    }
  });

  ws.on("close", () => {
    const roomData = rooms.get(ws.roomId);
    if (!roomData) return;
    if (ws.playerId && roomData.gameState?.players[ws.playerId]) {
      roomData.gameState.players[ws.playerId].ws = null;
      const allPlayersDisconnected = Object.values(roomData.gameState.players).every((p) => p.ws === null);
      if (allPlayersDisconnected) {
        roomData.gameState = null;
        roomData.lobby = [];
      } else {
        broadcastToRoom(ws.roomId, { type: "PLAYER_DISCONNECTED" });
      }
    } else {
      roomData.lobby = roomData.lobby.filter((p) => p.id !== ws.id);
      broadcastToRoom(ws.roomId, { type: "ROOM_UPDATE", count: roomData.lobby.length });
    }
  });
});
