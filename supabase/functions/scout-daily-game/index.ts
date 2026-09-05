import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { readJsonBody } from '../_shared/http.ts';
import {
  assertScoutDailyGamePublicBoard,
  buildScoutDailyGame,
} from '../_shared/scout-daily-games.mjs';

// The browser can call this endpoint, but it never receives an analytics
// project credential, raw RAPM component, archive descriptor, or provider ID.
// The dedicated analytics project only permits this service-role bridge.
const nbaUrl = 'https://fbbmuqbdpgsmvnezowwn.supabase.co';
const configuredUrl = String(Deno.env.get('ANALYTICS_SUPABASE_URL') || '').replace(/\/+$/, '');
const nbaKey = Deno.env.get('ANALYTICS_SUPABASE_SERVICE_ROLE_KEY') || '';
const nba = createClient(nbaUrl, nbaKey || 'unconfigured', { auth: { persistSession: false } });
const origins = new Set(['https://www.djshouseofcards-comics.com', 'https://djshouseofcards-comics.com']);
const gameKinds = new Set(['fix-the-five', 'draft-night']);
const gameFamilies = new Set(['team-season', 'franchise-window', 'multi-season-pool']);
const seedPattern = /^\d{4}-\d{2}-\d{2}$/;

type GameKind = 'fix-the-five' | 'draft-night';
type GameFamily = 'team-season' | 'franchise-window' | 'multi-season-pool';
type PublicPlayer = { id: string };
type FixChallenge = { id: string; candidates: readonly PublicPlayer[] };
type DraftRound = { candidates: readonly PublicPlayer[] };
type FixBoard = { contractVersion: number; gameKind: 'fix-the-five'; challenges: readonly FixChallenge[] };
type DraftBoard = { contractVersion: number; gameKind: 'draft-night'; deck: { rounds: readonly DraftRound[] } };
type DailyGameResult = {
  publicBoard: FixBoard | DraftBoard;
  sealedResults: Record<string, unknown>;
};
type ScoutCatalog = { scopes: unknown[] };
type DailyGameCompiler = (input: {
  gameKind: GameKind;
  dailySeed: string;
  family?: GameFamily | null;
  scopes: unknown[];
}) => DailyGameResult;

const compileDailyGame = buildScoutDailyGame as unknown as DailyGameCompiler;
let cachedCatalog: ScoutCatalog | null = null;
let cachedCatalogUntil = 0;

function normalizedSeed(value: unknown): string {
  const seed = String(value || '').trim();
  return seedPattern.test(seed) ? seed : '';
}

function normalizedKind(value: unknown): GameKind | '' {
  const kind = String(value || '').trim();
  return gameKinds.has(kind) ? kind as GameKind : '';
}

function normalizedFamily(value: unknown): GameFamily | '' | null {
  if (value === undefined || value === null || value === '') return null;
  const family = String(value).trim();
  return gameFamilies.has(family) ? family as GameFamily : '';
}

function responseHeaders(origin: string) {
  return {
    'Access-Control-Allow-Origin': origins.has(origin) ? origin : 'https://www.djshouseofcards-comics.com',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json',
  };
}

async function privateCatalog(): Promise<ScoutCatalog> {
  if (cachedCatalog && Date.now() < cachedCatalogUntil) return cachedCatalog;
  const { data, error } = await nba.rpc('get_nba_scout_daily_game_catalog');
  if (error || !data || typeof data !== 'object' || !Array.isArray((data as { scopes?: unknown }).scopes)) {
    throw new Error('Validated Scout catalog unavailable.');
  }
  const catalog = data as ScoutCatalog;
  if (!catalog.scopes.length) throw new Error('No validated Scout catalog scopes.');
  cachedCatalog = catalog;
  cachedCatalogUntil = Date.now() + 2 * 60 * 1000;
  return catalog;
}

function buildBoard(gameKind: GameKind, dailySeed: string, family: GameFamily | null): Promise<DailyGameResult> {
  return privateCatalog().then((catalog) => {
    const result = compileDailyGame({
      gameKind,
      dailySeed,
      family,
      scopes: catalog.scopes,
    });
    assertScoutDailyGamePublicBoard(result.publicBoard as never);
    return result;
  });
}

function fixReveal(result: DailyGameResult, body: Record<string, unknown>) {
  const challengeId = String(body.challengeId || '').trim();
  const candidateId = String(body.candidateId || '').trim();
  if (result.publicBoard.gameKind !== 'fix-the-five') return null;
  const challenge = result.publicBoard.challenges.find((entry) => entry.id === challengeId);
  if (!challenge || !challenge.candidates.some((entry: { id: string }) => entry.id === candidateId)) {
    return null;
  }
  const outcomes = result.sealedResults[challengeId];
  const outcome = outcomes && typeof outcomes === 'object' && !Array.isArray(outcomes)
    ? (outcomes as Record<string, unknown>)[candidateId]
    : null;
  return outcome || null;
}

function draftReveal(result: DailyGameResult, body: Record<string, unknown>) {
  const selectionIds = Array.isArray(body.selectionIds) ? body.selectionIds.map((value) => String(value || '').trim()) : [];
  if (result.publicBoard.gameKind !== 'draft-night') return null;
  const deck = result.publicBoard.deck;
  if (selectionIds.length !== deck.rounds.length || selectionIds.some((value) => !value)) return null;
  const legal = deck.rounds.every((round, index) => (
    round.candidates.some((candidate) => candidate.id === selectionIds[index])
  ));
  if (!legal || new Set(selectionIds).size !== selectionIds.length) return null;
  return result.sealedResults[selectionIds.join('|')] || null;
}

export default {
  fetch: async (request: Request) => {
    const origin = request.headers.get('origin') || '';
    const headers = responseHeaders(origin);
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return reply({ error: 'Origin not allowed.' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
    if (!nbaKey || configuredUrl !== nbaUrl) return reply({ error: 'Validated Scout games are temporarily unavailable.' }, 503);

    try {
      const body = await readJsonBody<Record<string, unknown>>(request, 12 * 1024);
      const action = String(body.action || 'board').trim();
      const gameKind = normalizedKind(body.gameKind);
      const dailySeed = normalizedSeed(body.dailySeed);
      const family = normalizedFamily(body.family);
      if (!gameKind || !dailySeed || family === '') {
        return reply({ error: 'Choose a supported game, calendar seed, and challenge family.' }, 400);
      }
      const result = await buildBoard(gameKind, dailySeed, family);
      if (action === 'board') return reply({ board: result.publicBoard });
      if (action !== 'reveal') return reply({ error: 'Use board or reveal.' }, 400);

      const outcome = gameKind === 'fix-the-five'
        ? fixReveal(result, body)
        : draftReveal(result, body);
      if (!outcome) return reply({ error: 'That selection is not on this fixed Scout board.' }, 400);
      return reply({
        contractVersion: result.publicBoard.contractVersion,
        gameKind,
        dailySeed,
        outcome,
      });
    } catch {
      // Deliberately do not serialize provider errors, model metadata, or any
      // private compiler input into a public response.
      return reply({ error: 'Validated Scout games are temporarily unavailable. Please try again later.' }, 503);
    }
  },
};
