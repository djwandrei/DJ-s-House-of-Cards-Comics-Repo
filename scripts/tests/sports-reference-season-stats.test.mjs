import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baseballReferenceSeasonPageUrl,
  parseBaseballReferenceSeasonPage,
  parseProFootballReferenceSeasonPage,
  proFootballReferenceSeasonPageUrl,
} from '../lib/sports-reference-season-stats.mjs';

const baseballBatting = `
<!-- <table id="teams_standard_batting"><tbody>
  <tr><th data-stat="team_name"><a href="/teams/PHI/1980.shtml">Philadelphia Phillies</a></th></tr>
</tbody></table> -->
<table id="players_standard_batting"><tbody>
  <tr>
    <th data-stat="name_display"><a href="/players/s/schmimi01.shtml">Mike Schmidt*</a></th>
    <td data-stat="age">30</td><td data-stat="team_name_abbr">PHI</td><td data-stat="pos">3B</td>
    <td data-stat="b_games">150</td><td data-stat="b_pa">617</td><td data-stat="b_hr">48</td>
    <td data-stat="b_batting_avg">.286</td><td data-stat="b_onbase_plus_slugging_plus">171</td>
    <td data-stat="awards">MVP</td>
  </tr>
</tbody></table>
<table id="players_standard_batting_post"><tbody>
  <tr>
    <th data-stat="name_display"><a href="/players/s/schmimi01.shtml">Mike Schmidt</a></th>
    <td data-stat="team_name_abbr">PHI</td><td data-stat="b_games">11</td><td data-stat="b_hr">2</td>
  </tr>
</tbody></table>`;

test('parses regular and postseason Baseball Reference player rows with metric JSON', () => {
  const sourceUrl = baseballReferenceSeasonPageUrl(1980, 'batting');
  const parsed = parseBaseballReferenceSeasonPage(baseballBatting, {
    seasonYear: 1980, statGroup: 'batting', sourceUrl,
  });
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.tableCounts, {
    players_standard_batting: 1,
    players_standard_batting_post: 1,
  });
  assert.deepEqual(parsed.rows[0], {
    externalId: 'schmimi01',
    fullName: 'Mike Schmidt',
    normalizedName: 'mike schmidt',
    teamCode: 'PHI',
    teamName: 'Philadelphia Phillies',
    seasonYear: 1980,
    seasonPhase: 'regular',
    statGroup: 'batting',
    isMultiTeamAggregate: false,
    listedPosition: '3B',
    playerAge: 30,
    gamesPlayed: 150,
    metrics: {
      b_games: 150,
      b_pa: 617,
      b_hr: 48,
      b_batting_avg: 0.286,
      b_onbase_plus_slugging_plus: 171,
    },
    sourceUrl,
    sourceRecordId: '1980:regular:batting:schmimi01:PHI',
    rawPayload: {
      name_display: 'Mike Schmidt*', age: '30', team_name_abbr: 'PHI', pos: '3B',
      b_games: '150', b_pa: '617', b_hr: '48', b_batting_avg: '.286',
      b_onbase_plus_slugging_plus: '171', awards: 'MVP',
    },
  });
  assert.equal(parsed.rows[1].seasonPhase, 'postseason');
});

test('converts Baseball Reference innings into exact outs', () => {
  const sourceUrl = baseballReferenceSeasonPageUrl(1980, 'pitching');
  const parsed = parseBaseballReferenceSeasonPage(`
    <table id="teams_standard_pitching"><tbody>
      <tr><th data-stat="team_name"><a href="/teams/HOU/1980.shtml">Houston Astros</a></th></tr>
    </tbody></table>
    <table id="players_standard_pitching"><tbody><tr>
      <th data-stat="name_display"><a href="/players/r/ryanno01.shtml">Nolan Ryan</a></th>
      <td data-stat="team_name_abbr">HOU</td><td data-stat="p_g">35</td><td data-stat="p_ip">233.2</td>
      <td data-stat="p_so">200</td><td data-stat="p_earned_run_avg">3.35</td>
    </tr></tbody></table>`, { seasonYear: 1980, statGroup: 'pitching', sourceUrl });
  assert.equal(parsed.rows[0].metrics.innings_pitched_outs, 701);
  assert.equal(parsed.rows[0].metrics.p_earned_run_avg, 3.35);
});

test('deduplicates league-specific Baseball Reference aggregate rows deterministically', () => {
  const sourceUrl = baseballReferenceSeasonPageUrl(2003, 'batting');
  const parsed = parseBaseballReferenceSeasonPage(`
    <table id="players_standard_batting"><tbody>
      <tr><th data-stat="name_display"><a href="/players/m/micelda01.shtml">Dan Miceli</a></th>
        <td data-stat="team_name_abbr">2TM</td><td data-stat="comp_name_abbr">NL</td><td data-stat="b_games">37</td></tr>
      <tr><th data-stat="name_display"><a href="/players/m/micelda01.shtml">Dan Miceli</a></th>
        <td data-stat="team_name_abbr">2TM</td><td data-stat="comp_name_abbr">AL</td><td data-stat="b_games">7</td></tr>
    </tbody></table>`, { seasonYear: 2003, statGroup: 'batting', sourceUrl });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.duplicateCount, 1);
  assert.equal(parsed.rows[0].gamesPlayed, 37);
  assert.equal(parsed.rows[0].rawPayload._deduped_variants.length, 1);
});

test('parses a Pro Football Reference stat table without inventing missing values', () => {
  const sourceUrl = proFootballReferenceSeasonPageUrl(1980, 'passing');
  const parsed = parseProFootballReferenceSeasonPage(`
    <!-- <table id="passing"><tbody><tr>
      <th data-stat="name_display"><a href="/players/A/AndeKe00.htm">Ken Anderson*</a></th>
      <td data-stat="age">31</td><td data-stat="team_name_abbr"><a href="/teams/cin/1980.htm">Cincinnati Bengals</a></td>
      <td data-stat="pos">QB</td><td data-stat="g">13</td><td data-stat="gs">13</td>
      <td data-stat="pass_cmp">243</td><td data-stat="pass_att">413</td><td data-stat="pass_yds">2,777</td>
      <td data-stat="pass_td">6</td><td data-stat="pass_int">9</td><td data-stat="qbr"></td>
    </tr></tbody></table> -->`, { seasonYear: 1980, statGroup: 'passing', sourceUrl });
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].externalId, 'AndeKe00');
  assert.equal(parsed.rows[0].teamCode, 'CIN');
  assert.equal(parsed.rows[0].teamName, 'Cincinnati Bengals');
  assert.equal(parsed.rows[0].gamesStarted, 13);
  assert.deepEqual(parsed.rows[0].metrics, {
    g: 13, gs: 13, pass_cmp: 243, pass_att: 413, pass_yds: 2777, pass_td: 6, pass_int: 9,
  });
});
