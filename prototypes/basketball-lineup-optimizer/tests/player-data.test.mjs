import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleSource = await readFile(new URL("../player-data.js", import.meta.url), "utf8");
const playerData = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource, "utf8").toString("base64")}`
);
const {
  datasetToCsv,
  normalizeDataset,
  normalizePlayer,
  parsePlayerCsv,
  slugifyPlayerId,
  validateDataset,
} = playerData;

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/timberwolves-2021-22.json", import.meta.url), "utf8"),
);

const ORIGINAL_HEADERS =
  "Player,Age,POS,G,GS,MPG,FG_pct,Three_pct,eFG_pct,FT_pct,TRB,AST,STL,BLK,TOV,PPG";

test("parses original workbook aliases and an explicit default team", () => {
  const csv = `${ORIGINAL_HEADERS}\nAnthony Edwards,20,G,53,53,34.6,.435,35.5%,.521,.776,4.8,3.6,1.5,.7,2.8,21.9`;
  const dataset = parsePlayerCsv(csv, { defaultTeam: "MIN" });

  assert.equal(dataset.diagnostics.errors.length, 0);
  assert.equal(dataset.players.length, 1);
  assert.deepEqual(dataset.players[0], {
    id: "anthony-edwards",
    name: "Anthony Edwards",
    team: "MIN",
    positions: ["G"],
    age: 20,
    games: 53,
    starts: 53,
    minutes: 34.6,
    fgPct: 0.435,
    threePct: 0.355,
    efgPct: 0.521,
    ftPct: 0.776,
    rebounds: 4.8,
    assists: 3.6,
    steals: 1.5,
    blocks: 0.7,
    turnovers: 2.8,
    points: 21.9,
  });
  assert.ok(dataset.diagnostics.warnings.some(({ code }) => code === "GENERATED_IDS"));
  assert.ok(dataset.diagnostics.warnings.some(({ code }) => code === "DEFAULT_TEAM_APPLIED"));
});

test("supports Basketball Reference headers, quoted commas, escaped quotes, and embedded newlines", () => {
  const headers = "Player,Tm,Pos,Age,G,GS,MP,FG%,3P%,eFG%,FT%,TRB,AST,STL,BLK,TOV,PTS";
  const csv = `${headers}\r\n"Russell, D""Angelo",MIN,PG-SG,25,45,45,32.2,.408,.351,.502,.802,3.5,7,.9,.5,2.5,18.8\r\n"Line\nBreak",MIN,SF/PF-C,24,1,0,1,50%,25%,50%,75%,1,2,3,4,0,5`;
  const dataset = parsePlayerCsv(csv);

  assert.equal(dataset.diagnostics.errors.length, 0);
  assert.equal(dataset.players[0].name, 'Russell, D"Angelo');
  assert.deepEqual(dataset.players[0].positions, ["G"]);
  assert.equal(dataset.players[1].name, "Line\nBreak");
  assert.deepEqual(dataset.players[1].positions, ["F", "C"]);
  assert.equal(dataset.players[1].fgPct, 0.5);
  assert.equal(dataset.players[1].threePct, 0.25);
});

test("normalizes aliases and position families while rejecting unsupported positions", () => {
  const normalized = normalizePlayer({
    Player: "Karl-Anthony Towns",
    Tm: "min",
    Pos: "PF/C",
    Age: "26",
    G: "52",
    GS: "52",
    MP: "34.3",
    "FG%": "52.2%",
    "3P%": ".409",
    "eFG%": ".586",
    "FT%": ".819",
    TRB: "9.7",
    AST: "4",
    STL: "1",
    BLK: "1.1",
    TOV: "3.3",
    PTS: "24.4",
  });
  assert.equal(normalized.id, "karl-anthony-towns");
  assert.equal(normalized.team, "MIN");
  assert.deepEqual(normalized.positions, ["F", "C"]);
  assert.equal(normalized.fgPct, 0.522);

  assert.throws(
    () => normalizePlayer({ ...normalized, positions: ["QB"] }),
    (error) =>
      error.name === "DatasetValidationError" &&
      error.diagnostics.errors.some(({ code }) => code === "INVALID_POSITION"),
  );
  assert.equal(slugifyPlayerId(" D'Angelo Russell "), "dangelo-russell");
});

test("validation flags missing values, nonfinite numbers, duplicates, and invalid positions", () => {
  const first = { ...fixture.players[0] };
  const second = {
    ...fixture.players[1],
    id: first.id,
    name: first.name,
    team: first.team,
    points: Number.NaN,
    positions: ["G", "X"],
  };
  const third = { ...fixture.players[2], team: "", assists: Number.POSITIVE_INFINITY };
  const result = validateDataset({ players: [first, second, third] });

  assert.equal(result.valid, false);
  for (const code of ["DUPLICATE_ID", "DUPLICATE_PLAYER", "INVALID_POSITION", "NONFINITE_NUMBER", "MISSING_FIELD"]) {
    assert.ok(result.errors.some((error) => error.code === code), `expected ${code}`);
  }
});

test("CSV export and import roundtrip the canonical player schema", () => {
  const original = { ...fixture, players: fixture.players.slice(0, 3) };
  const csv = datasetToCsv(original, { percentStyle: "percent", lineEnding: "lf" });
  assert.match(csv, /^ID,Player,Team,Pos,Age,G,GS,MP,FG%,3P%,eFG%,FT%,TRB,AST,STL,BLK,TOV,PTS\n/);

  const roundtrip = parsePlayerCsv(csv, { strict: true });
  assert.deepEqual(roundtrip.players, original.players);
  assert.equal(validateDataset(roundtrip).valid, true);
});

test("normalizes arrays and retains aggregate diagnostics instead of silently guessing", () => {
  const dataset = normalizeDataset(
    [
      {
        ...fixture.players[0],
        id: "",
      },
    ],
    { strict: false },
  );
  assert.equal(dataset.players[0].id, "anthony-edwards");
  assert.ok(dataset.diagnostics.warnings.some(({ code }) => code === "GENERATED_ID"));
});

test("fixture faithfully contains the 15-row course snapshot and source metadata", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.deepEqual(fixture.source, {
    label: "Basketball Reference",
    url: "https://www.basketball-reference.com/teams/MIN/2022.html",
    snapshotDate: "2022-02-27",
    season: "2021-22",
    note: "Course-project snapshot from the original LPsolve assignment; values are historical and are not live data.",
  });
  assert.equal(fixture.players.length, 15);
  assert.equal(validateDataset(fixture).valid, true);

  const anthony = fixture.players.find(({ id }) => id === "anthony-edwards");
  const towns = fixture.players.find(({ id }) => id === "karl-anthony-towns");
  const bolmaro = fixture.players.find(({ id }) => id === "leandro-bolmaro");
  assert.deepEqual(
    [anthony.games, anthony.minutes, anthony.points, anthony.threePct],
    [53, 34.6, 21.9, 0.355],
  );
  assert.deepEqual([towns.positions, towns.rebounds, towns.points], [["F", "C"], 9.7, 24.4]);
  assert.deepEqual([bolmaro.games, bolmaro.blocks, bolmaro.ftPct], [25, 0, 0.889]);
});
