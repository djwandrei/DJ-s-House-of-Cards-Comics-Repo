import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../supabase-analytics/supabase/migrations/20260825063723_harden_nba_pbp_function_grants.sql",
  import.meta.url,
);

test("PBP private functions are withheld from API roles while derived reads remain public", async () => {
  const sql = (await readFile(migrationUrl, "utf8")).toLowerCase();
  const privateFunctions = [
    "set_nba_records_updated_at()",
    "nba_lineup_metric_payload(numeric, integer, numeric, numeric, numeric, numeric)",
    "nba_invert_home_score_state_v1(text)",
    "ingest_nba_sportradar_game(jsonb)",
    "get_nba_rapm_stints(smallint, text)",
    "ingest_nba_rapm_model(jsonb)",
  ];
  const publicReads = [
    "get_nba_lineup_analytics(smallint, text, text, uuid[], text)",
    "get_nba_lineup_analytics_players(smallint, text, text)",
    "get_nba_adjusted_impacts(smallint, text, text)",
  ];

  for (const signature of privateFunctions) {
    assert.match(
      sql,
      new RegExp(`revoke all on function public\\.${signature.replace(/[()[\],]/g, "\\$&")}\\s+from public, anon, authenticated;`),
      `${signature} must be explicitly withheld from browser roles`,
    );
  }
  for (const signature of publicReads) {
    const escaped = signature.replace(/[()[\],]/g, "\\$&");
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}\\s+from public, anon, authenticated;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}\\s+to anon, authenticated;`));
  }
});
