#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { once } from 'node:events';

const COPY_PATTERN = /^COPY "public"\."([^"]+)" .* FROM stdin;$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    index += 1;
  }
  for (const required of ['input', 'baseball-output', 'football-output']) {
    if (!options[required]) {
      throw new Error(`Missing required option --${required}`);
    }
  }
  return options;
}

async function writeLine(stream, line) {
  if (!stream.write(`${line}\n`)) {
    await once(stream, 'drain');
  }
}

async function collectLeagueAthletes(inputPath) {
  const leagueAthletes = {
    MLB: new Set(),
    NFL: new Set(),
  };
  const mergedIntoByAthlete = new Map();
  let activeTable = null;

  const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const copyMatch = line.match(COPY_PATTERN);
    if (copyMatch) {
      activeTable = copyMatch[1];
      continue;
    }
    if (line === '\\.') {
      activeTable = null;
      continue;
    }
    if (activeTable === 'athlete_league_memberships') {
      const [athleteId, leagueCode] = line.split('\t', 2);
      leagueAthletes[leagueCode]?.add(athleteId);
    } else if (activeTable === 'athletes') {
      const columns = line.split('\t');
      if (columns[5] && columns[5] !== '\\N') {
        mergedIntoByAthlete.set(columns[0], columns[5]);
      }
    }
  }

  for (const athleteIds of Object.values(leagueAthletes)) {
    const pending = [...athleteIds];
    while (pending.length > 0) {
      const athleteId = pending.pop();
      const mergedIntoId = mergedIntoByAthlete.get(athleteId);
      if (mergedIntoId && !athleteIds.has(mergedIntoId)) {
        athleteIds.add(mergedIntoId);
        pending.push(mergedIntoId);
      }
    }
  }

  return leagueAthletes;
}

function routeRow(tableName, line, leagueAthletes) {
  if (tableName === 'athletes') {
    const athleteId = line.slice(0, line.indexOf('\t'));
    return {
      baseball: leagueAthletes.MLB.has(athleteId),
      football: leagueAthletes.NFL.has(athleteId),
    };
  }

  if (tableName === 'sports') {
    const sportCode = line.slice(0, line.indexOf('\t'));
    return { baseball: sportCode === 'baseball', football: sportCode === 'football' };
  }

  if (tableName === 'sports_leagues') {
    const leagueCode = line.slice(0, line.indexOf('\t'));
    return { baseball: leagueCode === 'MLB', football: leagueCode === 'NFL' };
  }

  if (['athlete_league_memberships', 'athlete_aliases', 'athlete_external_ids'].includes(tableName)) {
    const columns = line.split('\t', 3);
    return { baseball: columns[1] === 'MLB', football: columns[1] === 'NFL' };
  }

  if (tableName.startsWith('mlb_')) {
    return { baseball: true, football: false };
  }
  if (tableName.startsWith('nfl_')) {
    return { baseball: false, football: true };
  }

  throw new Error(`Unrecognized public data table in source dump: ${tableName}`);
}

async function splitDump(inputPath, outputPaths, leagueAthletes) {
  for (const outputPath of Object.values(outputPaths)) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }

  const outputs = {
    baseball: fs.createWriteStream(outputPaths.baseball, { encoding: 'utf8' }),
    football: fs.createWriteStream(outputPaths.football, { encoding: 'utf8' }),
  };
  const counts = { baseball: {}, football: {} };
  const headers = {
    baseball: '-- Baseball analytics data split generated from the verified pre-retirement source dump.',
    football: '-- Football analytics data split generated from the verified pre-retirement source dump.',
  };
  for (const [target, output] of Object.entries(outputs)) {
    await writeLine(output, headers[target]);
    await writeLine(output, '\\set ON_ERROR_STOP on');
    await writeLine(output, 'SET statement_timeout = 0;');
    await writeLine(output, 'SET lock_timeout = 0;');
    await writeLine(output, 'SET client_encoding = \'UTF8\';');
    await writeLine(output, 'SET standard_conforming_strings = on;');
    await writeLine(output, 'SET row_security = off;');
    await writeLine(output, 'SET ROLE postgres;');
    await writeLine(output, 'SET session_replication_role = replica;');
    await writeLine(output, '');
  }

  let activeTable = null;
  let activeTargets = [];
  const input = fs.createReadStream(inputPath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    const copyMatch = line.match(COPY_PATTERN);
    if (copyMatch) {
      activeTable = copyMatch[1];
      activeTargets = ['sports', 'sports_leagues'].includes(activeTable)
        ? []
        : activeTable.startsWith('mlb_')
          ? ['baseball']
          : activeTable.startsWith('nfl_')
            ? ['football']
            : ['baseball', 'football'];
      for (const target of activeTargets) {
        counts[target][activeTable] = 0;
        await writeLine(outputs[target], line);
      }
      continue;
    }

    if (activeTable) {
      if (line === '\\.') {
        for (const target of activeTargets) {
          await writeLine(outputs[target], line);
          await writeLine(outputs[target], '');
        }
        activeTable = null;
        activeTargets = [];
        continue;
      }
      const route = routeRow(activeTable, line, leagueAthletes);
      for (const target of activeTargets) {
        if (route[target]) {
          await writeLine(outputs[target], line);
          counts[target][activeTable] += 1;
        }
      }
      continue;
    }

    if (line.startsWith('SELECT pg_catalog.setval(')) {
      if (line.includes('"public"."mlb_')) {
        await writeLine(outputs.baseball, line);
      } else if (line.includes('"public"."nfl_')) {
        await writeLine(outputs.football, line);
      }
    }
  }

  for (const output of Object.values(outputs)) {
    await writeLine(output, '');
    await writeLine(output, 'SET session_replication_role = origin;');
    await writeLine(output, 'RESET ROLE;');
    output.end();
  }
  await Promise.all(Object.values(outputs).map((output) => once(output, 'finish')));
  return counts;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  const outputPaths = {
    baseball: path.resolve(options['baseball-output']),
    football: path.resolve(options['football-output']),
  };

  const leagueAthletes = await collectLeagueAthletes(inputPath);
  const counts = await splitDump(inputPath, outputPaths, leagueAthletes);
  const result = {
    source: inputPath,
    outputs: Object.fromEntries(
      Object.entries(outputPaths).map(([target, outputPath]) => [
        target,
        { path: outputPath, bytes: fs.statSync(outputPath).size, rows: counts[target] },
      ]),
    ),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
