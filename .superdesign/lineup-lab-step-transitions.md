# Preview refinement: move through the coaching journey

Extend the active v9 preview, not the production site. Preserve its visual
direction, all 31 palettes, automatic team colors, separate dark/light mode,
original DJ/Lab emblems, fonts, and existing Game Plan controls and behavior.

## Five panels, one shared shell

Keep the header, desktop progress rail, compact mobile progress, and game-plan
ticket stable. Only the active step's content changes. Start at step 1.

1. Team & Season: move the existing Team selector here, showing all 30 teams
   and the neutral no-selection option. Retain the explicit 2021–22 design-demo
   season. Changing team automatically changes colors. Continue requires a team;
   if missing, show a local inline error and focus the selector. No data fetching.
2. Game Plan: retain the existing full v9 content (strategy cards, prompt
   browse/apply, Simple/Detailed, build type and dependent rotation size).
3. Players: show five clearly labeled position placeholders, not real players
   or invented metrics. Explain that eligible players load here in the real
   application. This is only a transition preview and does not imply a loaded
   or valid roster. Keep a clear Continue to Rules action.
4. Rules: a compact read-only preview of the current setup: five-player lineup
   or 8–12-player/240-minute rotation as selected, with a note that real player
   eligibility and position constraints are checked by the actual optimizer.
   Do not create new constraint behavior or fabricate satisfied rules.
5. Review & Build: live summary of the selected team, demo season, strategy,
   build type, and size. Explicitly show player data as not loaded. The final
   button is "Finish preview", producing a truthful design-review completion
   message. No real/fake solve, loading progress, scoring, or predicted results.

## Navigation and motion

- Use a single Next/Back bar with contextual next-step labels. Back is disabled
  on step 1. The current step is indicated via both a label and aria-current=step.
- Keep every step mounted and hide/inert inactive steps so input values survive
  Next, Back, and Edit. Inactive fields must not be tab stops or screen-reader
  content. Do not use innerHTML to recreate the Game Plan and lose listeners.
- Next: a brief outgoing fade then incoming slide/fade from the right (16–24px).
  Back reverses direction. Keep total transition around 240–280ms, no long travel,
  bounce, flashing, autoplay, or page reload. Animate the small progress indicator.
- Ignore repeated activation while transitioning; no double-step skipping and
  no permanently disabled controls. Navigation must work without Web Animations.
- After changing panels, focus the new step heading (tabindex=-1) and put it
  below the sticky header/mobile progress, without scrolling behind chrome.
- Reduced-motion skips spatial movement and animation delays. If the preference
  changes mid-transition, settle to a valid visible panel and release the lock.
- Colors, dark/light preference, strategy and rotation size survive navigation.
  Keep the existing Court style disclosure available across steps; only the team
  selection drives palette choice. Appearance must never write back to team data.
- Desktop and 320px mobile: one active panel, no horizontal overflow, controls
  >=44px, sticky chrome never overlaps a focused heading or final action.

This is a multi-state single-page preview, not new routes or generated pages.
Keep a visible design-preview notice and the existing source/affiliation caveat.
Use the exact fonts/colors/spacing in the existing design system and palette
extension. No new dependencies beyond the draft's existing Tailwind/Iconify.
