/**
 * Canonical player-data helpers for the basketball lineup optimizer prototype.
 *
 * Parsing is deliberately dependency-free so this module can run directly in a
 * browser. Importers receive collected diagnostics by default; pass
 * `{ strict: true }` to `normalizeDataset` or `parsePlayerCsv` to reject input
 * when any validation error is found.
 */

const PLAYER_FIELDS = Object.freeze([
  "id",
  "name",
  "team",
  "positions",
  "age",
  "games",
  "starts",
  "minutes",
  "fgPct",
  "threePct",
  "efgPct",
  "ftPct",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
]);

const INTEGER_FIELDS = new Set(["age", "games", "starts"]);
const PERCENTAGE_FIELDS = new Set(["fgPct", "threePct", "efgPct", "ftPct"]);
const COUNTING_FIELDS = new Set([
  "minutes",
  "rebounds",
  "assists",
  "steals",
  "blocks",
  "turnovers",
  "points",
]);
const VALID_POSITIONS = new Set(["G", "F", "C"]);

const FIELD_LABELS = Object.freeze({
  id: "ID",
  name: "Player",
  team: "Team",
  positions: "Pos",
  age: "Age",
  games: "G",
  starts: "GS",
  minutes: "MP",
  fgPct: "FG%",
  threePct: "3P%",
  efgPct: "eFG%",
  ftPct: "FT%",
  rebounds: "TRB",
  assists: "AST",
  steals: "STL",
  blocks: "BLK",
  turnovers: "TOV",
  points: "PTS",
});

const HEADER_ALIAS_GROUPS = Object.freeze({
  id: ["id", "player id", "player_id"],
  name: ["player", "name", "player name", "player_name"],
  team: ["team", "tm"],
  positions: ["pos", "position", "positions"],
  age: ["age"],
  games: ["g", "gp", "games", "games played"],
  starts: ["gs", "starts", "games started"],
  minutes: ["mp", "mpg", "min", "minutes", "minutes per game"],
  fgPct: ["fg%", "fg pct", "fg_pct", "fgpct", "field goal pct", "field goal percentage"],
  threePct: [
    "3p%",
    "3p pct",
    "3p_pct",
    "3ppct",
    "three pct",
    "three_pct",
    "three point pct",
    "three point percentage",
  ],
  efgPct: ["efg%", "efg pct", "efg_pct", "efgpct", "effective field goal pct"],
  ftPct: ["ft%", "ft pct", "ft_pct", "ftpct", "free throw pct", "free throw percentage"],
  rebounds: ["trb", "reb", "rebounds", "rpg"],
  assists: ["ast", "assists", "apg"],
  steals: ["stl", "steals", "spg"],
  blocks: ["blk", "blocks", "bpg"],
  turnovers: ["tov", "to", "turnovers", "topg"],
  points: ["pts", "ppg", "points", "points per game"],
});

function normalizeAliasKey(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/%/g, " pct ")
    .replace(/[^a-z0-9]+/g, "")
    .replace(/percentage/g, "pct");
}

const HEADER_ALIASES = new Map();
for (const [field, aliases] of Object.entries(HEADER_ALIAS_GROUPS)) {
  HEADER_ALIASES.set(normalizeAliasKey(field), field);
  for (const alias of aliases) {
    HEADER_ALIASES.set(normalizeAliasKey(alias), field);
  }
}

function createDiagnostics(seed) {
  const diagnostics = { errors: [], warnings: [] };
  if (seed && typeof seed === "object") {
    if (Array.isArray(seed.errors)) diagnostics.errors.push(...seed.errors);
    if (Array.isArray(seed.warnings)) diagnostics.warnings.push(...seed.warnings);
  }
  return diagnostics;
}

function addDiagnostic(diagnostics, severity, code, path, message, value) {
  const target = severity === "warning" ? diagnostics.warnings : diagnostics.errors;
  const diagnostic = { code, path, message };
  if (value !== undefined) diagnostic.value = value;
  const key = `${code}|${path}|${message}`;
  if (!target.some((item) => `${item.code}|${item.path}|${item.message}` === key)) {
    target.push(diagnostic);
  }
}

function mergeDiagnostics(target, source) {
  for (const diagnostic of source.errors ?? []) {
    addDiagnostic(target, "error", diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.value);
  }
  for (const diagnostic of source.warnings ?? []) {
    addDiagnostic(target, "warning", diagnostic.code, diagnostic.path, diagnostic.message, diagnostic.value);
  }
  return target;
}

function validationError(message, diagnostics) {
  const error = new TypeError(message);
  error.name = "DatasetValidationError";
  error.diagnostics = diagnostics;
  return error;
}

function isBlank(value) {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function normalizeText(value) {
  return isBlank(value) ? "" : String(value).trim();
}

/** Create a stable, URL-safe player identifier from a name or supplied ID. */
export function slugifyPlayerId(value) {
  return normalizeText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019'`\u00b4]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function valuesDiffer(left, right) {
  if (isBlank(left) && isBlank(right)) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return JSON.stringify(left) !== JSON.stringify(right);
  }
  return String(left).trim() !== String(right).trim();
}

function mapPlayerFields(input, diagnostics, path, reportUnknownFields) {
  const mapped = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const canonical = HEADER_ALIASES.get(normalizeAliasKey(rawKey));
    if (!canonical) {
      if (reportUnknownFields) {
        addDiagnostic(
          diagnostics,
          "warning",
          "UNKNOWN_FIELD",
          `${path}.${rawKey}`,
          `Ignored unrecognized player field "${rawKey}".`,
        );
      }
      continue;
    }

    if (Object.hasOwn(mapped, canonical) && valuesDiffer(mapped[canonical], value)) {
      addDiagnostic(
        diagnostics,
        "error",
        "CONFLICTING_FIELD_ALIASES",
        `${path}.${canonical}`,
        `Multiple columns map to ${FIELD_LABELS[canonical]} and contain different values.`,
      );
      continue;
    }
    mapped[canonical] = value;
  }
  return mapped;
}

function normalizePositions(value, diagnostics, path) {
  if (isBlank(value) || (Array.isArray(value) && value.length === 0)) {
    addDiagnostic(diagnostics, "error", "MISSING_FIELD", path, "At least one position is required.");
    return [];
  }

  const rawParts = (Array.isArray(value) ? value : [value]).flatMap((part) =>
    String(part)
      .toUpperCase()
      .split(/[\s/,|;+\-]+/)
      .filter(Boolean),
  );
  const normalized = [];
  const positionMap = {
    G: "G",
    PG: "G",
    SG: "G",
    F: "F",
    SF: "F",
    PF: "F",
    C: "C",
  };

  for (const token of rawParts) {
    const position = positionMap[token];
    if (!position) {
      addDiagnostic(
        diagnostics,
        "error",
        "INVALID_POSITION",
        path,
        `Unsupported position "${token}". Use guard (G), forward (F), or center (C).`,
        token,
      );
      continue;
    }
    if (!normalized.includes(position)) normalized.push(position);
  }

  if (normalized.length === 0 && rawParts.length > 0) {
    addDiagnostic(diagnostics, "error", "MISSING_VALID_POSITION", path, "No valid basketball position was supplied.");
  }
  return normalized;
}

function normalizeNumber(value, field, diagnostics, path) {
  if (isBlank(value)) {
    addDiagnostic(diagnostics, "error", "MISSING_FIELD", path, `${FIELD_LABELS[field]} is required.`);
    return null;
  }

  let normalizedValue = value;
  let percentNotation = false;
  if (typeof normalizedValue === "string") {
    normalizedValue = normalizedValue.trim();
    if (PERCENTAGE_FIELDS.has(field) && normalizedValue.endsWith("%")) {
      percentNotation = true;
      normalizedValue = normalizedValue.slice(0, -1).trim();
    }
  }

  let number = typeof normalizedValue === "number" ? normalizedValue : Number(normalizedValue);
  if (percentNotation) number = Number((number / 100).toFixed(12));

  if (!Number.isFinite(number)) {
    addDiagnostic(
      diagnostics,
      "error",
      "NONFINITE_NUMBER",
      path,
      `${FIELD_LABELS[field]} must be a finite number.`,
      value,
    );
    return null;
  }

  if (INTEGER_FIELDS.has(field) && !Number.isInteger(number)) {
    addDiagnostic(
      diagnostics,
      "error",
      "NONINTEGER_NUMBER",
      path,
      `${FIELD_LABELS[field]} must be a whole number.`,
      value,
    );
  }
  if (number < 0) {
    addDiagnostic(
      diagnostics,
      "error",
      "OUT_OF_RANGE",
      path,
      `${FIELD_LABELS[field]} cannot be negative.`,
      value,
    );
  }
  if (PERCENTAGE_FIELDS.has(field) && number > 1) {
    addDiagnostic(
      diagnostics,
      "error",
      "OUT_OF_RANGE",
      path,
      `${FIELD_LABELS[field]} must be a decimal from 0 to 1 or a value ending in %.`,
      value,
    );
  }
  if (field === "age" && number > 100) {
    addDiagnostic(diagnostics, "error", "OUT_OF_RANGE", path, "Age must be between 0 and 100.", value);
  }
  return number;
}

/**
 * Normalize one aliased/raw row into the canonical player schema.
 * Invalid standalone rows throw by default. Callers collecting multiple rows
 * can provide `{ diagnostics, strict: false }`.
 */
export function normalizePlayer(input, options = {}) {
  const ownsDiagnostics = !options.diagnostics;
  const diagnostics = options.diagnostics ?? createDiagnostics();
  const startingErrorCount = diagnostics.errors.length;
  const path = options.path ?? "player";

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    addDiagnostic(diagnostics, "error", "INVALID_PLAYER", path, "Player data must be an object.", input);
    if (options.strict ?? true) {
      throw validationError("Player normalization failed.", diagnostics);
    }
    return Object.fromEntries(PLAYER_FIELDS.map((field) => [field, field === "positions" ? [] : null]));
  }

  const mapped = mapPlayerFields(input, diagnostics, path, options.reportUnknownFields === true);
  const name = normalizeText(mapped.name);
  if (!name) addDiagnostic(diagnostics, "error", "MISSING_FIELD", `${path}.name`, "Player name is required.");

  let team = normalizeText(mapped.team);
  if (!team && !isBlank(options.defaultTeam)) {
    team = normalizeText(options.defaultTeam);
    addDiagnostic(
      diagnostics,
      "warning",
      "DEFAULT_TEAM_APPLIED",
      `${path}.team`,
      `Applied the explicitly supplied default team "${team}".`,
    );
  }
  if (!team) addDiagnostic(diagnostics, "error", "MISSING_FIELD", `${path}.team`, "Team is required.");
  team = team.toUpperCase();

  const suppliedId = normalizeText(mapped.id);
  const id = slugifyPlayerId(suppliedId || name);
  if (!id) {
    addDiagnostic(diagnostics, "error", "MISSING_FIELD", `${path}.id`, "A player ID or name is required.");
  } else if (!suppliedId && options.warnOnGeneratedId !== false) {
    addDiagnostic(
      diagnostics,
      "warning",
      "GENERATED_ID",
      `${path}.id`,
      `Generated player ID "${id}" from the player name.`,
    );
  } else if (suppliedId && suppliedId !== id) {
    addDiagnostic(
      diagnostics,
      "warning",
      "NORMALIZED_ID",
      `${path}.id`,
      `Normalized player ID "${suppliedId}" to "${id}".`,
    );
  }

  const player = {
    id,
    name,
    team,
    positions: normalizePositions(mapped.positions, diagnostics, `${path}.positions`),
    age: normalizeNumber(mapped.age, "age", diagnostics, `${path}.age`),
    games: normalizeNumber(mapped.games, "games", diagnostics, `${path}.games`),
    starts: normalizeNumber(mapped.starts, "starts", diagnostics, `${path}.starts`),
    minutes: normalizeNumber(mapped.minutes, "minutes", diagnostics, `${path}.minutes`),
    fgPct: normalizeNumber(mapped.fgPct, "fgPct", diagnostics, `${path}.fgPct`),
    threePct: normalizeNumber(mapped.threePct, "threePct", diagnostics, `${path}.threePct`),
    efgPct: normalizeNumber(mapped.efgPct, "efgPct", diagnostics, `${path}.efgPct`),
    ftPct: normalizeNumber(mapped.ftPct, "ftPct", diagnostics, `${path}.ftPct`),
    rebounds: normalizeNumber(mapped.rebounds, "rebounds", diagnostics, `${path}.rebounds`),
    assists: normalizeNumber(mapped.assists, "assists", diagnostics, `${path}.assists`),
    steals: normalizeNumber(mapped.steals, "steals", diagnostics, `${path}.steals`),
    blocks: normalizeNumber(mapped.blocks, "blocks", diagnostics, `${path}.blocks`),
    turnovers: normalizeNumber(mapped.turnovers, "turnovers", diagnostics, `${path}.turnovers`),
    points: normalizeNumber(mapped.points, "points", diagnostics, `${path}.points`),
  };

  if (
    Number.isFinite(player.starts) &&
    Number.isFinite(player.games) &&
    player.starts > player.games
  ) {
    addDiagnostic(
      diagnostics,
      "error",
      "STARTS_EXCEED_GAMES",
      `${path}.starts`,
      "Games started cannot exceed games played.",
      player.starts,
    );
  }

  const strict = options.strict ?? ownsDiagnostics;
  if (strict && diagnostics.errors.length > startingErrorCount) {
    throw validationError("Player normalization failed.", diagnostics);
  }
  return player;
}

function cloneSource(source) {
  return source && typeof source === "object" && !Array.isArray(source) ? { ...source } : {};
}

/** Normalize a player array or `{ players }` dataset and retain diagnostics. */
export function normalizeDataset(input, options = {}) {
  const diagnostics = options.diagnostics ?? createDiagnostics(input?.diagnostics);
  let rawPlayers;
  let schemaVersion = options.schemaVersion ?? 1;
  let source = cloneSource(options.source);

  if (Array.isArray(input)) {
    rawPlayers = input;
  } else if (input && typeof input === "object") {
    rawPlayers = input.players;
    schemaVersion = input.schemaVersion ?? schemaVersion;
    source = cloneSource(input.source ?? source);
  } else {
    rawPlayers = null;
  }

  if (!Array.isArray(rawPlayers)) {
    addDiagnostic(
      diagnostics,
      "error",
      "INVALID_DATASET",
      "players",
      "Dataset must be an array or an object with a players array.",
    );
    rawPlayers = [];
  }

  const players = rawPlayers.map((rawPlayer, index) =>
    normalizePlayer(rawPlayer, {
      defaultTeam: options.defaultTeam,
      diagnostics,
      path: `players[${index}]`,
      reportUnknownFields: options.reportUnknownFields,
      strict: false,
      warnOnGeneratedId: options.warnOnGeneratedId,
    }),
  );
  const dataset = { schemaVersion, source, players };
  mergeDiagnostics(diagnostics, validateDataset(dataset));
  dataset.diagnostics = diagnostics;

  if (options.strict === true && diagnostics.errors.length > 0) {
    throw validationError("Dataset normalization failed.", diagnostics);
  }
  return dataset;
}

function parseCsvRows(csvText) {
  const text = String(csvText ?? "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0 || quoteClosed) {
        throw new SyntaxError(`Unexpected quote in CSV at character ${index + 1}.`);
      }
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      quoteClosed = false;
    } else {
      if (quoteClosed && !/\s/.test(character)) {
        throw new SyntaxError(`Unexpected character after a closing CSV quote at character ${index + 1}.`);
      }
      field += character;
    }
  }

  if (quoted) throw new SyntaxError("CSV contains an unterminated quoted field.");
  if (field.length > 0 || row.length > 0 || quoteClosed) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => String(cell).trim() !== ""));
}

/**
 * Parse Basketball Reference/share CSV or the original course workbook's
 * headers. The returned dataset includes `{ diagnostics: {errors,warnings} }`.
 */
export function parsePlayerCsv(csvText, options = {}) {
  if (typeof csvText !== "string") throw new TypeError("CSV input must be a string.");
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) throw new SyntaxError("CSV input is empty.");

  const diagnostics = createDiagnostics();
  const rawHeaders = rows[0];
  const mappedHeaders = [];
  const fieldToColumn = new Map();

  rawHeaders.forEach((header, columnIndex) => {
    const field = HEADER_ALIASES.get(normalizeAliasKey(header));
    mappedHeaders[columnIndex] = field ?? null;
    if (!field) {
      addDiagnostic(
        diagnostics,
        "warning",
        "UNKNOWN_HEADER",
        `headers[${columnIndex}]`,
        isBlank(header) ? "Ignored a blank CSV header." : `Ignored unrecognized CSV header "${String(header).trim()}".`,
      );
      return;
    }
    if (fieldToColumn.has(field)) {
      addDiagnostic(
        diagnostics,
        "error",
        "DUPLICATE_HEADER",
        `headers[${columnIndex}]`,
        `Multiple CSV columns map to ${FIELD_LABELS[field]}.`,
      );
    } else {
      fieldToColumn.set(field, columnIndex);
    }
  });

  const requiredHeaders = PLAYER_FIELDS.filter((field) => field !== "id" && field !== "team");
  if (!fieldToColumn.has("team") && isBlank(options.defaultTeam)) requiredHeaders.push("team");
  for (const field of requiredHeaders) {
    if (!fieldToColumn.has(field)) {
      addDiagnostic(
        diagnostics,
        "error",
        "MISSING_HEADER",
        "headers",
        `Missing required ${FIELD_LABELS[field]} column.`,
      );
    }
  }
  if (!fieldToColumn.has("id")) {
    addDiagnostic(
      diagnostics,
      "warning",
      "GENERATED_IDS",
      "headers",
      "No ID column was provided; IDs were generated from player names.",
    );
  }

  const players = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex];
    if (cells.length > rawHeaders.length) {
      addDiagnostic(
        diagnostics,
        "error",
        "EXTRA_CSV_FIELDS",
        `rows[${rowIndex + 1}]`,
        `CSV row ${rowIndex + 1} has more fields than the header row.`,
      );
    }
    const rawPlayer = {};
    for (let columnIndex = 0; columnIndex < rawHeaders.length; columnIndex += 1) {
      const field = mappedHeaders[columnIndex];
      if (field && !Object.hasOwn(rawPlayer, field)) rawPlayer[field] = cells[columnIndex] ?? "";
    }
    players.push(
      normalizePlayer(rawPlayer, {
        defaultTeam: options.defaultTeam,
        diagnostics,
        path: `rows[${rowIndex + 1}]`,
        strict: false,
        warnOnGeneratedId: false,
      }),
    );
  }

  const dataset = {
    schemaVersion: options.schemaVersion ?? 1,
    source: cloneSource(options.source),
    players,
  };
  mergeDiagnostics(diagnostics, validateDataset(dataset));
  dataset.diagnostics = diagnostics;

  if (options.strict === true && diagnostics.errors.length > 0) {
    throw validationError("CSV player data failed validation.", diagnostics);
  }
  return dataset;
}

function validateTextField(player, field, path, diagnostics) {
  if (typeof player[field] !== "string" || player[field].trim() === "") {
    addDiagnostic(diagnostics, "error", "MISSING_FIELD", `${path}.${field}`, `${FIELD_LABELS[field]} is required.`);
  }
}

function validateNumericField(player, field, path, diagnostics) {
  const value = player[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addDiagnostic(
      diagnostics,
      "error",
      "NONFINITE_NUMBER",
      `${path}.${field}`,
      `${FIELD_LABELS[field]} must be a finite number.`,
      value,
    );
    return;
  }
  if (value < 0) {
    addDiagnostic(
      diagnostics,
      "error",
      "OUT_OF_RANGE",
      `${path}.${field}`,
      `${FIELD_LABELS[field]} cannot be negative.`,
      value,
    );
  }
  if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) {
    addDiagnostic(
      diagnostics,
      "error",
      "NONINTEGER_NUMBER",
      `${path}.${field}`,
      `${FIELD_LABELS[field]} must be a whole number.`,
      value,
    );
  }
  if (PERCENTAGE_FIELDS.has(field) && value > 1) {
    addDiagnostic(
      diagnostics,
      "error",
      "OUT_OF_RANGE",
      `${path}.${field}`,
      `${FIELD_LABELS[field]} must be between 0 and 1.`,
      value,
    );
  }
  if (field === "age" && value > 100) {
    addDiagnostic(diagnostics, "error", "OUT_OF_RANGE", `${path}.age`, "Age must be between 0 and 100.", value);
  }
}

/** Validate the canonical dataset without mutating it. */
export function validateDataset(input) {
  const diagnostics = createDiagnostics();
  const players = Array.isArray(input) ? input : input?.players;
  if (!Array.isArray(players)) {
    addDiagnostic(diagnostics, "error", "INVALID_DATASET", "players", "Dataset must contain a players array.");
    return { valid: false, ...diagnostics };
  }
  if (players.length === 0) {
    addDiagnostic(diagnostics, "warning", "EMPTY_DATASET", "players", "Dataset contains no players.");
  }

  const ids = new Map();
  const identities = new Map();
  players.forEach((player, index) => {
    const path = `players[${index}]`;
    if (!player || typeof player !== "object" || Array.isArray(player)) {
      addDiagnostic(diagnostics, "error", "INVALID_PLAYER", path, "Player data must be an object.", player);
      return;
    }

    validateTextField(player, "id", path, diagnostics);
    validateTextField(player, "name", path, diagnostics);
    validateTextField(player, "team", path, diagnostics);

    if (!Array.isArray(player.positions) || player.positions.length === 0) {
      addDiagnostic(
        diagnostics,
        "error",
        "MISSING_FIELD",
        `${path}.positions`,
        "At least one position is required.",
      );
    } else {
      const seenPositions = new Set();
      for (const position of player.positions) {
        if (!VALID_POSITIONS.has(position)) {
          addDiagnostic(
            diagnostics,
            "error",
            "INVALID_POSITION",
            `${path}.positions`,
            `Unsupported position "${position}". Use G, F, or C.`,
            position,
          );
        } else if (seenPositions.has(position)) {
          addDiagnostic(
            diagnostics,
            "warning",
            "DUPLICATE_POSITION",
            `${path}.positions`,
            `Position "${position}" is repeated.`,
          );
        }
        seenPositions.add(position);
      }
    }

    for (const field of [...INTEGER_FIELDS, ...PERCENTAGE_FIELDS, ...COUNTING_FIELDS]) {
      validateNumericField(player, field, path, diagnostics);
    }
    if (Number.isFinite(player.starts) && Number.isFinite(player.games) && player.starts > player.games) {
      addDiagnostic(
        diagnostics,
        "error",
        "STARTS_EXCEED_GAMES",
        `${path}.starts`,
        "Games started cannot exceed games played.",
        player.starts,
      );
    }

    if (typeof player.id === "string" && player.id.trim() !== "") {
      const idKey = player.id.trim().toLowerCase();
      if (ids.has(idKey)) {
        addDiagnostic(
          diagnostics,
          "error",
          "DUPLICATE_ID",
          `${path}.id`,
          `Player ID "${player.id}" duplicates ${ids.get(idKey)}.`,
        );
      } else {
        ids.set(idKey, `${path}.id`);
      }
      if (slugifyPlayerId(player.id) !== player.id) {
        addDiagnostic(
          diagnostics,
          "warning",
          "NONCANONICAL_ID",
          `${path}.id`,
          `Player ID should use the canonical slug "${slugifyPlayerId(player.id)}".`,
        );
      }
    }

    if (typeof player.name === "string" && typeof player.team === "string") {
      const identity = `${player.team.trim().toLowerCase()}|${player.name.trim().toLowerCase()}`;
      if (identity !== "|" && identities.has(identity)) {
        addDiagnostic(
          diagnostics,
          "error",
          "DUPLICATE_PLAYER",
          path,
          `Player "${player.name}" on ${player.team} duplicates ${identities.get(identity)}.`,
        );
      } else if (identity !== "|") {
        identities.set(identity, path);
      }
    }
  });

  return { valid: diagnostics.errors.length === 0, ...diagnostics };
}

function csvCell(value) {
  const stringValue = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(stringValue) || /^\s|\s$/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function percentageForCsv(value, style) {
  if (style === "percent") return `${Number((value * 100).toFixed(6))}%`;
  return value;
}

/** Serialize a valid dataset using canonical Basketball Reference-style headers. */
export function datasetToCsv(input, options = {}) {
  const dataset = normalizeDataset(input, {
    defaultTeam: options.defaultTeam,
    source: options.source,
    strict: false,
    warnOnGeneratedId: false,
  });
  if (dataset.diagnostics.errors.length > 0 && options.allowInvalid !== true) {
    throw validationError("Cannot export invalid player data to CSV.", dataset.diagnostics);
  }

  const includeId = options.includeId !== false;
  const fields = includeId ? PLAYER_FIELDS : PLAYER_FIELDS.filter((field) => field !== "id");
  const percentStyle = options.percentStyle === "percent" ? "percent" : "decimal";
  const lines = [fields.map((field) => csvCell(FIELD_LABELS[field])).join(",")];

  for (const player of dataset.players) {
    const values = fields.map((field) => {
      if (field === "positions") return player.positions.join("/");
      if (PERCENTAGE_FIELDS.has(field) && Number.isFinite(player[field])) {
        return percentageForCsv(player[field], percentStyle);
      }
      return player[field];
    });
    lines.push(values.map(csvCell).join(","));
  }
  const lineEnding = options.lineEnding === "lf" ? "\n" : "\r\n";
  return `${lines.join(lineEnding)}${lineEnding}`;
}
