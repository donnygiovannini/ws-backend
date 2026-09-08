import { randomUUID } from "node:crypto";

export const MIN_CARDS = 20;
export const MAX_CARDS = 40;
export const MAX_CARD_LENGTH = 120;

export function createDeck() {
  return { cards: [], revision: 0, drafts: {} };
}

export function normalizeCard(value) {
  if (typeof value !== "string") throw new Error("Each card must contain text.");
  const text = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!text) throw new Error("Write something on the card first.");
  if (text.length > MAX_CARD_LENGTH) throw new Error(`Keep each card to ${MAX_CARD_LENGTH} characters or fewer.`);
  return text;
}

const key = (text) => text.toLocaleLowerCase("en-US");

// The server applies individual operations, never client copies of the whole deck.
// Concurrent additions therefore cannot overwrite one another.
export function addCards(deck, values) {
  if (!Array.isArray(values) || !values.length || values.length > 200) throw new Error("Paste between 1 and 200 lines at a time.");
  const known = new Set(deck.cards.map((card) => key(card.text)));
  const unique = [];
  for (const value of values) {
    const text = normalizeCard(value);
    if (known.has(key(text))) continue;
    known.add(key(text));
    unique.push(text);
  }
  if (deck.cards.length + unique.length > MAX_CARDS) throw new Error(`Only ${MAX_CARDS - deck.cards.length} spaces left. Add fewer cards.`);
  deck.cards.push(...unique.map((text) => ({ id: randomUUID(), text, version: 1 })));
  if (unique.length) deck.revision++;
  return { added: unique.length, skipped: values.length - unique.length };
}

export function updateCard(deck, { id, text, version }, clientId) {
  const card = deck.cards.find((item) => item.id === id);
  if (!card) throw new Error("That card was removed. Add your text as a new card instead.");
  if (card.version !== version) throw new Error("That card changed. Reopen it to edit the latest version.");
  if (Object.entries(deck.drafts).some(([owner, draft]) => owner !== clientId && draft.cardId === id)) throw new Error("Your partner is editing that card.");
  const normalized = normalizeCard(text);
  if (deck.cards.some((item) => item.id !== id && key(item.text) === key(normalized))) throw new Error("That card is already in the deck.");
  card.text = normalized;
  card.version++;
  deck.revision++;
}

export function removeCard(deck, { id, version }, clientId) {
  const card = deck.cards.find((item) => item.id === id);
  if (!card) return;
  if (card.version !== version) throw new Error("That card changed. Try removing it again.");
  if (Object.entries(deck.drafts).some(([owner, draft]) => owner !== clientId && draft.cardId === id)) throw new Error("Your partner is editing that card.");
  deck.cards = deck.cards.filter((item) => item.id !== id);
  deck.revision++;
}

export function setDraft(deck, clientId, { text = "", cardId = null }) {
  if (typeof text !== "string" || text.length > MAX_CARD_LENGTH) throw new Error(`Keep each card to ${MAX_CARD_LENGTH} characters or fewer.`);
  if (cardId !== null) {
    if (!deck.cards.some((card) => card.id === cardId)) throw new Error("That card was removed.");
    if (Object.entries(deck.drafts).some(([owner, draft]) => owner !== clientId && draft.cardId === cardId)) throw new Error("Your partner is editing that card.");
  }
  if (!text && !cardId) delete deck.drafts[clientId];
  else deck.drafts[clientId] = { text, cardId };
}

export function validateDeckForGame(deck) {
  if (deck.cards.length < MIN_CARDS || deck.cards.length > MAX_CARDS) throw new Error("Add 20–40 cards before starting Custom Cards.");
  if (Object.keys(deck.drafts).length) throw new Error("Finish adding or editing cards before starting the game.");
  return deck.cards.map((card) => card.text);
}
