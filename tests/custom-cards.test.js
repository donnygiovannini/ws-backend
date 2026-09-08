import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { addCards, createDeck, normalizeCard } from "../deck.js";

test("imports normalize whitespace, preserve names, deduplicate and validate atomically", () => {
  const deck = createDeck();
  assert.deepEqual(addCards(deck, ["  María   José García ", "maría josé garcía", "A quiet Sunday"]), { added: 2, skipped: 1 });
  assert.equal(deck.cards[0].text, "María José García");
  assert.equal(normalizeCard("x".repeat(120)).length, 120);
  assert.throws(() => addCards(deck, ["Valid", "x".repeat(121)]), /120/);
  assert.equal(deck.cards.length, 2);
  assert.throws(() => addCards(deck, [""]), /Write/);
  assert.throws(() => addCards(deck, Array.from({ length: 40 }, (_, i) => `Card ${i}`)), /spaces/);
  assert.equal(deck.cards.length, 2);
});

test("shared custom deck protocol and game lifecycle", { timeout: 25000 }, async (t) => {
  const server = spawn(process.execPath, ["server.js"], { cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  const sockets = [];
  t.after(() => { sockets.forEach((ws) => ws.terminate()); server.kill(); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Server startup timed out")), 5000);
    server.stdout.on("data", (chunk) => { const match = String(chunk).match(/localhost:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
    server.once("exit", () => { clearTimeout(timer); reject(new Error("Server exited")); });
  });
  const base = `ws://127.0.0.1:${port}`;
  async function client(room, clientId = randomUUID(), identify = true) {
    const ws = new WebSocket(`${base}/${room}`);
    sockets.push(ws);
    const messages = [], waiting = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw);
      const index = waiting.findIndex((waiter) => waiter.type === message.type && waiter.matches(message));
      if (index < 0) messages.push(message);
      else waiting.splice(index, 1)[0].resolve(message);
    });
    await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const c = {
      ws, clientId, actorId: null,
      send(type, payload = {}) { ws.send(JSON.stringify({ type, payload })); },
      next(type, matches = () => true) {
        const index = messages.findIndex((message) => message.type === type && matches(message));
        if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out: ${type}`)), 3000);
          waiting.push({ type, matches, resolve: (message) => { clearTimeout(timer); resolve(message); } });
        });
      },
      async op(type, payload = {}, error = false) {
        const requestId = randomUUID();
        c.send(type, { ...payload, requestId });
        return (await c.next(error ? "DECK_ERROR" : "DECK_ACK", (message) => message.payload.requestId === requestId)).payload;
      },
      async deck() {
        // Consume a snapshot newer than any already queued broadcast.
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].type === "DECK_STATE") messages.splice(i, 1);
        c.send("DECK_GET");
        return (await c.next("DECK_STATE")).payload;
      },
    };
    if (identify) { c.send("IDENTIFY_LOBBY", { clientId }); c.actorId = (await c.next("ROOM_IDENTITY")).payload.actorId; await c.next("DECK_STATE"); }
    return c;
  }
  const room = randomUUID();
  const a = await client(room);
  await a.op("DECK_ADD", { cards: ["María José García", "My childhood home"] });
  const b = await client(room);
  assert.equal((await b.deck()).cards.length, 2, "late join sees the current deck");
  const outsider = await client(room, randomUUID(), false);
  assert.match((await outsider.op("DECK_ADD", { cards: ["Intruder"] }, true)).message, /Connect/);
  outsider.send("START_GAME", { gameType: "custom_cards", role: "sender" });
  assert.match((await outsider.next("ERROR")).payload.message, /Connect/);

  await Promise.all([
    a.op("DECK_ADD", { cards: Array.from({ length: 8 }, (_, i) => `Alice ${i}`) }),
    b.op("DECK_ADD", { cards: Array.from({ length: 9 }, (_, i) => `Bob ${i}`) }),
  ]);
  assert.equal((await a.deck()).cards.length, 19, "simultaneous adds both survive");
  a.send("START_GAME", { gameType: "custom_cards", role: "sender" });
  assert.match((await a.next("ERROR")).payload.message, /20–40/);
  await b.op("DECK_ADD", { cards: ["Twentieth card"] });
  a.send("DECK_DRAFT", { text: "Typing together" });
  assert.equal((await b.next("DECK_STATE", (m) => !!m.payload.drafts[a.actorId])).payload.drafts[a.actorId].text, "Typing together");
  assert.notEqual(a.actorId, a.clientId, "shared draft attribution must not reveal a reconnect credential");
  a.send("START_GAME", { gameType: "custom_cards", role: "sender" });
  assert.match((await a.next("ERROR")).payload.message, /Finish/);
  a.send("DECK_DRAFT", { text: "" });

  const card = (await a.deck()).cards[0];
  a.send("DECK_DRAFT", { cardId: card.id, text: "A new full name" });
  await b.next("DECK_STATE", (m) => m.payload.drafts[a.actorId]?.cardId === card.id);
  assert.match((await b.op("DECK_REMOVE", card, true)).message, /partner/);
  await a.op("DECK_UPDATE", { ...card, text: "A new full name" });
  assert.match((await b.op("DECK_UPDATE", { ...card, text: "Stale overwrite" }, true)).message, /changed/);
  assert.equal((await b.deck()).cards[0].text, "A new full name");

  await a.op("DECK_ADD", { cards: Array.from({ length: 19 }, (_, i) => `Extra ${i}`) });
  const requests = [randomUUID(), randomUUID()];
  a.send("DECK_ADD", { requestId: requests[0], cards: ["Last from Alice"] });
  b.send("DECK_ADD", { requestId: requests[1], cards: ["Last from Bob"] });
  // Frames from different sockets may arrive in either order; inspect the final deck.
  await Promise.all([a.deck(), b.deck()]);
  const full = await a.deck();
  assert.equal(full.cards.length, 40);
  assert.equal(full.cards.filter((c) => c.text.startsWith("Last from")).length, 1);
  assert.match((await a.op("DECK_ADD", { cards: ["Overflow"] }, true)).message, /0 spaces/);

  const replacement = await client(room, b.clientId);
  assert.deepEqual((await replacement.deck()).cards, full.cards, "reconnection preserves saved cards");
  const isolated = await client(randomUUID());
  assert.equal((await isolated.deck()).cards.length, 0);
  a.ws.send("invalid json");
  await a.next("ERROR");
  assert.equal((await fetch(base.replace("ws:", "http:") + "/health")).status, 200);

  a.send("START_GAME", { gameType: "custom_cards", role: "sender" });
  const starts = await Promise.all([a.next("GAME_STARTED"), replacement.next("GAME_STARTED")]);
  assert.equal(starts[1].payload.role, "receiver", "starts even when the other player never opens the editor");
  assert.match((await a.op("DECK_REMOVE", full.cards[0], true)).message, /locked/);
  for (const [i, c] of [a, replacement].entries()) c.send("PLAYER_READY", { playerId: starts[i].payload.playerId });
  const expected = new Set(full.cards.map((c) => c.text));
  for (let round = 1; round <= 10; round++) {
    const [s, r] = await Promise.all([a.next("NEW_ROUND"), replacement.next("NEW_ROUND")]);
    assert.equal(s.payload.round, round); assert.equal(r.payload.round, round);
    assert.equal(r.payload.sender, null);
    assert.equal(r.payload.receiver.options.length, 4);
    assert.equal(new Set(r.payload.receiver.options).size, 4);
    assert(r.payload.receiver.options.every((text) => expected.has(text)));
    assert(expected.has(s.payload.sender.correctItem));
    replacement.send("SUBMIT_GUESS", { item: s.payload.sender.correctItem });
    const result = await Promise.all([a.next("GUESS_RESULT"), replacement.next("GUESS_RESULT")]);
    assert.equal(result[0].payload.score, round);
    assert.equal(result[1].payload.score, round);
    replacement.send("SUBMIT_GUESS", { item: s.payload.sender.correctItem });
    a.send("REQUEST_NEXT_ROUND"); replacement.send("REQUEST_NEXT_ROUND");
  }
  for (const c of [a, replacement]) assert.equal((await c.next("GAME_OVER")).payload.finalScore, 10);
  assert.equal((await a.deck()).editable, true);
  a.send("REQUEST_REMATCH", { switchRoles: true });
  const restarts = await Promise.all([a.next("GAME_RESTARTED"), replacement.next("GAME_RESTARTED")]);
  assert.equal(restarts[0].payload.role, "receiver");
  assert.equal(restarts[1].payload.role, "sender");
  for (const [i, c] of [a, replacement].entries()) c.send("PLAYER_READY", { playerId: restarts[i].payload.playerId });
  const round = await replacement.next("NEW_ROUND");
  assert(expected.has(round.payload.sender.correctItem));
});
