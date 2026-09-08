import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

// Supply an explicit staging URL to avoid accidentally testing production.
const base = process.argv[2];
assert(base && /^wss?:\/\//.test(base), "Usage: node scripts/smoke.mjs <staging-websocket-url>");
const sockets = [];
async function client(room) {
  const ws = new WebSocket(`${base.replace(/\/$/, "")}/${room}`);
  sockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw);
    const index = waiters.findIndex((w) => w.type === message.type);
    if (index < 0) queue.push(message);
    else waiters.splice(index, 1)[0].resolve(message);
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return {
    send: (type, payload) => ws.send(JSON.stringify({ type, payload })),
    next(type) {
      const index = queue.findIndex((m) => m.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 15000);
        waiters.push({ type, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    },
  };
}
async function play(a, b, roles, customDeck = null) {
  const sender = roles[0] === "sender" ? a : b;
  const receiver = roles[0] === "receiver" ? a : b;
  let score = 0;
  for (let round = 1; round <= 10; round++) {
    const [s, r] = await Promise.all([sender.next("NEW_ROUND"), receiver.next("NEW_ROUND")]);
    assert.equal(s.payload.round, round);
    assert.equal(r.payload.round, round);
    assert.equal(r.payload.sender, null);
    assert.equal(s.payload.receiver, null);
    assert.equal(r.payload.receiver.options.length, 4);
    assert(r.payload.receiver.options.includes(s.payload.sender.correctItem));
    if (customDeck) assert(r.payload.receiver.options.every((item) => customDeck.includes(item)));
    const correct = round % 2 === 1;
    const item = correct ? s.payload.sender.correctItem : r.payload.receiver.options.find((x) => x !== s.payload.sender.correctItem);
    receiver.send("SUBMIT_GUESS", { item });
    if (correct) score++;
    const results = await Promise.all([a.next("GUESS_RESULT"), b.next("GUESS_RESULT")]);
    for (const result of results) {
      assert.equal(result.payload.score, score);
      assert.equal(result.payload.result, correct ? "Correct" : "Wrong");
    }
    a.send("REQUEST_NEXT_ROUND");
    b.send("REQUEST_NEXT_ROUND");
  }
  for (const end of await Promise.all([a.next("GAME_OVER"), b.next("GAME_OVER")])) assert.equal(end.payload.finalScore, 5);
}
try {
  const health = await fetch(`${base.replace(/^ws/, "http").replace(/\/$/, "")}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  for (const gameType of ["colors", "emotions", "random_words", "numbers", "custom_cards"]) {
    const room = `staging-smoke-${randomUUID()}`;
    const a = await client(room);
    const b = await client(room);
    const isolated = await client(`${room}-isolated`);
    a.send("IDENTIFY_LOBBY");
    assert.equal((await a.next("ROOM_UPDATE")).count, 1);
    isolated.send("IDENTIFY_LOBBY");
    assert.equal((await isolated.next("ROOM_UPDATE")).count, 1);
    b.send("IDENTIFY_LOBBY");
    for (const update of await Promise.all([a.next("ROOM_UPDATE"), b.next("ROOM_UPDATE")])) assert.equal(update.count, 2);
    const customDeck = gameType === "custom_cards" ? Array.from({ length: 20 }, (_, i) => `Custom full name and phrase ${i + 1}`) : null;
    if (customDeck) {
      a.send("DECK_ADD", { cards: customDeck });
      assert.equal((await a.next("DECK_ACK")).payload.added, 20);
    }
    a.send("START_GAME", { gameType, role: "sender" });
    const started = await Promise.all([a.next("GAME_STARTED"), b.next("GAME_STARTED")]);
    started.forEach((m, i) => {
      assert.equal(m.payload.gameType, gameType);
      assert.equal(m.payload.role, i === 0 ? "sender" : "receiver");
      [a, b][i].send("PLAYER_READY", { playerId: m.payload.playerId });
    });
    await play(a, b, ["sender", "receiver"], customDeck);
    a.send("REQUEST_REMATCH", { switchRoles: true });
    const restarted = await Promise.all([a.next("GAME_RESTARTED"), b.next("GAME_RESTARTED")]);
    restarted.forEach((m, i) => {
      assert.equal(m.payload.role, i === 0 ? "receiver" : "sender");
      [a, b][i].send("PLAYER_READY", { playerId: m.payload.playerId });
    });
    await play(a, b, ["receiver", "sender"], customDeck);
    console.log(`PASS ${gameType}: pairing, isolated room, 10 rounds, scores, rematch with switched roles`);
    sockets.forEach((s) => s.close());
  }
} finally {
  sockets.forEach((s) => s.close());
}
