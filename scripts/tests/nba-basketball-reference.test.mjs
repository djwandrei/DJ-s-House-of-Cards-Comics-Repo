import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractHeadshotAsset,
  extractTeamLogoAsset,
  parseAdvancedPage,
  parseLeagueTeamsPage,
  parseTotalsPage
} from '../lib/nba-basketball-reference.mjs';

const regularTotalsFixture = `
<!--
<table id="totals_stats">
  <tbody>
    <tr class="thead"><th data-stat="ranker">Rk</th></tr>
    <tr>
      <th data-stat="name_display"><a href="/players/a/abdulka01.html">Kareem Abdul-Jabbar*</a></th>
      <td data-stat="age">32</td><td data-stat="team_name_abbr">LAL</td><td data-stat="pos">C</td>
      <td data-stat="games">82</td><td data-stat="games_started">82</td><td data-stat="mp">3143</td>
      <td data-stat="fg">835</td><td data-stat="fga">1383</td><td data-stat="fg3">0</td><td data-stat="fg3a">1</td>
      <td data-stat="ft">364</td><td data-stat="fta">475</td><td data-stat="orb">190</td><td data-stat="drb">696</td>
      <td data-stat="trb">886</td><td data-stat="ast">371</td><td data-stat="stl">81</td><td data-stat="blk">280</td>
      <td data-stat="tov">297</td><td data-stat="pf">216</td><td data-stat="pts">2034</td>
    </tr>
    <tr>
      <th data-stat="name_display"><a href="/players/n/nattca01.html">Calvin Natt</a></th>
      <td data-stat="age">23</td><td data-stat="team_name_abbr">2TM</td><td data-stat="pos">PF</td>
      <td data-stat="games">80</td><td data-stat="games_started"></td><td data-stat="mp">2400</td>
      <td data-stat="fg">500</td><td data-stat="fga">1000</td><td data-stat="fg3"></td><td data-stat="fg3a"></td>
      <td data-stat="ft">200</td><td data-stat="fta">250</td><td data-stat="orb">100</td><td data-stat="drb">300</td>
      <td data-stat="trb">400</td><td data-stat="ast">100</td><td data-stat="stl">50</td><td data-stat="blk">40</td>
      <td data-stat="tov">100</td><td data-stat="pf">200</td><td data-stat="pts">1200</td>
    </tr>
  </tbody>
</table>
-->
`;

const advancedFixture = `
<table id="advanced"><tbody>
  <tr>
    <th data-stat="name_display"><a href="/players/a/abdulka01.html">Kareem Abdul-Jabbar</a></th>
    <td data-stat="team_name_abbr">LAL</td><td data-stat="pos">C</td><td data-stat="age">32</td>
    <td data-stat="per">25.3</td><td data-stat="ts_pct">.639</td><td data-stat="fg3a_per_fga_pct">.001</td>
    <td data-stat="ows">10.5</td><td data-stat="dws">5.9</td><td data-stat="ws">16.4</td><td data-stat="bpm">7.2</td>
  </tr>
</tbody></table>`;

test('parses commented regular totals tables and preserves multi-team rows', () => {
  const parsed = parseTotalsPage(regularTotalsFixture, {
    seasonEndYear: 1980,
    seasonPhase: 'regular',
    sourceUrl: 'https://example.test/NBA_1980_totals.html'
  });
  assert.equal(parsed.tableId, 'totals_stats');
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[0], {
    externalId: 'abdulka01',
    fullName: 'Kareem Abdul-Jabbar',
    normalizedName: 'kareem abdul-jabbar',
    listedPosition: 'C',
    playerAge: 32,
    teamCode: 'LAL',
    isMultiTeamAggregate: false,
    gamesPlayed: 82,
    gamesStarted: 82,
    minutesPlayed: 3143,
    fieldGoalsMade: 835,
    fieldGoalsAttempted: 1383,
    threePointFieldGoalsMade: 0,
    threePointFieldGoalsAttempted: 1,
    freeThrowsMade: 364,
    freeThrowsAttempted: 475,
    offensiveRebounds: 190,
    defensiveRebounds: 696,
    totalRebounds: 886,
    assists: 371,
    steals: 81,
    blocks: 280,
    turnovers: 297,
    personalFouls: 216,
    points: 2034,
    sourceUrl: 'https://example.test/NBA_1980_totals.html',
    sourceRecordId: '1980:regular:totals:abdulka01:LAL',
    rawPayload: {
      name_display: 'Kareem Abdul-Jabbar*',
      age: '32',
      team_name_abbr: 'LAL',
      pos: 'C',
      games: '82',
      games_started: '82',
      mp: '3143',
      fg: '835',
      fga: '1383',
      fg3: '0',
      fg3a: '1',
      ft: '364',
      fta: '475',
      orb: '190',
      drb: '696',
      trb: '886',
      ast: '371',
      stl: '81',
      blk: '280',
      tov: '297',
      pf: '216',
      pts: '2034'
    }
  });
  assert.equal(parsed.rows[1].isMultiTeamAggregate, true);
  assert.equal(parsed.rows[1].gamesStarted, null);
  assert.equal(parsed.rows[1].threePointFieldGoalsMade, null);
});

test('maps advanced data-stat aliases into normalized metric codes', () => {
  const parsed = parseAdvancedPage(advancedFixture, {
    seasonEndYear: 1980,
    seasonPhase: 'regular',
    sourceUrl: 'https://example.test/NBA_1980_advanced.html'
  });
  assert.equal(parsed.tableId, 'advanced');
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].metrics, {
    player_efficiency_rating: 25.3,
    true_shooting_percentage: 0.639,
    three_point_attempt_rate: 0.001,
    offensive_win_shares: 10.5,
    defensive_win_shares: 5.9,
    win_shares: 16.4,
    box_plus_minus: 7.2
  });
});

test('reads historical teams and remote media URLs from source markup', () => {
  const teamFixture = `
    <table id="per_game-team"><tbody>
      <tr><th data-stat="team"><a href="/teams/LAL/1980.html">Los Angeles Lakers</a>*</th></tr>
      <tr><th data-stat="team"><a href="/teams/SDC/1980.html">San Diego Clippers</a></th></tr>
    </tbody></table>`;
  const teams = parseLeagueTeamsPage(teamFixture, { seasonEndYear: 1980 });
  assert.equal(teams.get('LAL'), 'Los Angeles Lakers');
  assert.equal(teams.get('SDC'), 'San Diego Clippers');
  assert.equal(
    extractHeadshotAsset('https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg', 'abdulka01'),
    'https://www.basketball-reference.com/req/202605210/images/headshots/abdulka01.jpg'
  );
  assert.equal(
    extractTeamLogoAsset('https://cdn.ssref.net/req/202608202/tlogo/bbr/LAL-1980.png', 'LAL', 1980),
    'https://cdn.ssref.net/req/202608202/tlogo/bbr/LAL-1980.png'
  );
});
