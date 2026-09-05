# Gobert / Beringer allocation diagnostic — September 5, 2026

## Finding and limits

The current Historical model can still overvalue an expanded Beringer role.
This is primarily a rate/objective modeling problem, not evidence that the
integer allocator ignores weights. It is not reproduced for every objective:
defense and rebounding favor Gobert in the controlled C-only comparison below.

The user's earlier scenario URL, settings, and exact model revision were not
available. These are current-code reproductions, not a claimed reconstruction
of that earlier run. No private Scout coefficients were loaded or evaluated.
No coefficients, positions, database rows, or minute limits were changed to
make this comparison favor either player.

## Reproduce safely

```powershell
node scripts/diagnose-lineup-center-case.mjs --live
node scripts/diagnose-lineup-center-case.mjs --live --centers-only
node scripts/diagnose-lineup-center-case.mjs --live --centers-only --details
```

The opt-in script uses the existing public browser SDK, shared Supabase reader,
prototype adapter, and exact solver. It accepts only GETs to the two reviewed
public NBA tables/views on the configured dedicated NBA project. It does not
read env credentials, create sessions, or write to Supabase. The successful
run made three public SELECT requests, each returning HTTP 200.

It holds nine players fixed: Gobert, Beringer, Anthony Edwards, Donte
DiVincenzo, Julius Randle, Jaden McDaniels, Bones Hyland, Ayo Dosunmu, and Kyle
Anderson. Percentiles still use the full 21-player Minnesota pool. The common
rules are 240 total minutes, 8–40 minutes each, 96 G / 96 F / 48 C minutes,
no sample eligibility threshold, and role-balance bonus off.

The current page's default eight-MPG filter excludes Beringer's 7.85-MPG row.
That is an eligibility setting, not a solution to the projection problem, so
the diagnostic explicitly includes him. Seven objectives are tested against
raw rates, approximate samples, actual imported season samples, and the
uncalibrated assumptions. The latter is a sensitivity check, not an older
release. Both position variants completed all 28 scenarios (56 total).

## What the imported 2025–26 regular-season data says

| Field | Rudy Gobert | Joan Beringer |
| --- | ---: | ---: |
| Games | 76 | 40 |
| Total minutes | 2,380 | 314 |
| Minutes per appearance | 31.32 | 7.85 |
| Points per 36 | 12.54 | 17.89 |
| Rebounds per 36 | 13.19 | 10.55 |
| Blocks per 36 | 1.88 | 2.98 |
| Fouls per 36 | 3.01 | 5.39 |
| Three-point makes / attempts | 0 / 5 | 0 / 0 |
| Effective FG% | 68.23% | 66.33% |
| Imported OBPM / DBPM | 0.0 / 0.9 | 0.2 / 0.2 |

These are the database values used by the tool, not independently reconciled
official game-by-game totals. Both players have only one imported team row in
this season, so their own team and all-team counts match.

## Controlled allocation: same center eligibility

For this diagnostic only, both players are assigned C-only eligibility. This
removes Beringer's F/C flexibility as a confounder and makes their minutes add
to 48. No position record is edited.

| Current model with actual samples | Gobert minutes | Beringer minutes |
| --- | ---: | ---: |
| Balanced | 21 | 27 |
| Offense | 8 | 40 |
| Defense | 39 | 9 |
| Own the Glass | 36 | 12 |
| Rebounds only | 40 | 8 |
| Blocks only | 8 | 40 |
| DBPM only | 40 | 8 |

## Root causes supported by this investigation

1. **Zero attempts can become spacing credit.** The shrinkage calculation
   returns the league-average 3P% when attempts are zero. That is a prior mean,
   not evidence of a shooting role. In the actual-sample offense case, Beringer
   receives a 47.5th-percentile three-point score despite taking no threes;
   Gobert receives 35th percentile for 0/5. Neither should be credited with
   demonstrated spacing merely because this percentage prior exists.

2. **The fitted workload path does not validate extreme role extrapolation.**
   Beringer's 314 minutes and 7.85 MPG produce attractive points/block rates.
   Current 2026 fitted priors are only 100 minutes for points and blocks, and
   the fitted expansion strength is zero for both. The allocator therefore
   retains those adjusted rates at 40 minutes. The chronological benchmark
   measures later-game prediction at observed workloads; it does not establish
   that an approximately fivefold role expansion preserves these rates.
   Zero fitted decline must not be described as validated zero extrapolation
   risk. This does not justify imposing a universal fatigue penalty either.

3. **Percentile scores magnify tiny and uncertain differences.** Beringer's
   0.2 OBPM versus Gobert's 0.0 becomes 70th versus 32.5th percentile in this
   pool after shrinkage. An uncertain small signed difference can thus receive
   a large relative ranking gap. Beringer also receives better points, blocks,
   and turnover percentiles. Changing family weights changes which such gaps
   dominate; it does not turn these proxies into an overall player ranking.

4. **The position comparison can be misleading.** The imported record lists
   Beringer's season role as F and verified eligibility as F/C; Gobert is C.
   With unrestricted imported flexibility, Beringer can receive forward time
   while Gobert occupies center. In the actual-sample balanced fixed-roster
   case, they receive 40 and 39 total minutes, respectively—not a division of
   the same 48 center minutes. Primary sources themselves use different labels:
   the [Timberwolves' draft announcement calls Beringer a center](https://www.nba.com/timberwolves/news/timberwolves-select-joan-beringer-17th-overall-in-the-2025-nba-draft),
   while his [NBA profile lists forward](https://www.nba.com/player/1642866).
   A displayed position label is not tracked on-court role evidence.

5. **Blocks are an incomplete defensive objective.** Box-score blocks do not
   measure all rim deterrence, coverage, or shot-quality effects. NBA's
   [Gobert film study](https://www.nba.com/news/film-study-rudy-gobert-will-transform-wolves-already-improved-defense)
   distinguishes blocked shots, contests, and deterrence. The current small
   DBPM cross-check is not a replacement for validated possession-based defense.

6. **Foul cost is absent from the historical objective.** Imported personal
   fouls imply approximately 5.39 per 36 for Beringer versus 3.01 for Gobert.
   The current box-score optimizer does not price that tradeoff against blocks
   or model the risk of losing availability to fouls. Simply scaling this rate
   to a large role is not a validated forecast, but ignoring the evidence while
   scaling the attractive block rate is asymmetric.

## Recommended next model changes, before the next model release

1. Separate **shooting accuracy** from **shooting participation/spacing**.
   A zero-attempt player gets no demonstrated spacing contribution. Small
   positive samples remain appropriately shrunk; they should not be handled by
   a discontinuous eligibility cutoff. Preserve unknown skill as uncertainty,
   not measured zero accuracy or fictitious average shooting ability.
2. Validate role expansion using prior-game role and future opportunity
   variables, with a separate out-of-support uncertainty treatment. Correct
   expected production/efficiency where supported; never set Gobert-specific
   bonuses, Beringer-specific penalties, or targets that mimic coaching minutes.
3. Test role-appropriate priors and cardinal objective scales so noisy small
   differences do not receive the same rank separation as established large
   differences. Keep exact constraints and explicit user priorities intact.
4. Use validated Scout O/D coefficients for impact objectives. Keep box-score
   custom objectives clearly labeled, and do not double count DBPM or use raw
   block rates as a substitute for measured defensive impact. Evaluate foul
   cost and availability risk alongside positive defensive events.
5. Add rate/support/spacing and position-allocation regression cases for many
   reserve/starter pairs and eras. Do not tune the entire model until this one
   player's minutes look familiar. Repeat held-out evaluation before promotion.

The read-only season bridge fixes sample availability and missing-count
semantics; it does not by itself fix these scoring/extrapolation issues. It is
currently local and was not included in the completed `20260905c` cPanel release.
