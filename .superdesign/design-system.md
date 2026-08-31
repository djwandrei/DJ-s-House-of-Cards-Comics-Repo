# DJ's House of Cards & Comics homepage design system

## Source of truth and brand intent

The current DJHC storefront homepage is the sole visual and structural source
of truth. DJHC is an independent collector-led shop for sports cards, comics,
memorabilia, and hobby finds. The experience should remain recognizable as the
existing site: personal, energetic, trustworthy, sports-rooted, and centered on
photographs of the exact items being sold.

The shopper journey is: understand DJHC and its guarantee, search or enter a
department, browse featured inventory, inspect the exact item, then ask, offer,
save, or buy with confidence. Improvements may clarify and compress that path,
but must not replace the homepage with an unrelated product or sub-brand UI.

## Current-homepage visual DNA

- Keep the exact existing DJHC logo visible in the header, hero brand area, and
  footer. Never replace it with initials, emoji, a generic mark, an invented
  SVG, or text alone.
- Preserve the deep-navy site chrome, royal-blue primary actions, DJHC red and
  collector-gold accents, pale blue/white content sections, and the grass-field
  hero image that gives the homepage its recognizable sports setting.
- Preserve the homepage's two-part hero idea: value proposition and guarantee
  on one side; DJHC identity, browsing, marketplace, and account entry points on
  the other. The composition may become shorter and clearer, but these homepage
  roles remain the structural basis.
- Use the current rounded translucent panels, bordered cards, restrained
  shadows, condensed sports headings, script accent, and true-item product
  photography. Refine their hierarchy rather than replacing them with a new
  editorial, analytics, dashboard, casino, or generic marketplace aesthetic.
- Avoid neon, fake scarcity, invented authentication badges, unsupported value
  claims, and unrelated stock imagery.

## Color

| Role | Value |
| --- | --- |
| Brand blue / primary action | `#1f2fa3` |
| Deep navy / feature background | `#101b46` |
| Blue highlight | `#384bc8` |
| DJHC red / decisive accent | `#ef1823` |
| Dark red | `#b40f18` |
| Collector gold / rare emphasis | `#e4b141` |
| Optional warm neutral accent | `#f5f0e8` |
| Cool storefront canvas | `#eef3fb` |
| White surface | `#ffffff` |
| Main ink | `#172033` |
| Muted ink | `#5c667f` |
| Border | `rgba(24, 37, 73, 0.14)` |
| Success | `#08775b` |
| Warning | `#9a5b00` |
| Error | `#b51524` |

Red and gold are accents, not background defaults. Gold may emphasize a special
homepage feature but must not imply grading, authentication, rarity, or value.
Dark mode uses navy/ink surfaces with off-white text and preserves contrast.

## Typography

- **Inter** (400 and 700) is the body, navigation, product-fact, control, and
  transactional typeface.
- **Bebas Neue** is the existing athletic display face for major headings,
  prices, years, and compact labels.
- **Lobster Two** is reserved for the existing DJ's House of Cards script accent
  and should appear sparingly.
- Hero display: `clamp(3.4rem, 7vw, 6.4rem)`, tight 0.9-1.0 line-height.
- Section titles: `clamp(1.8rem, 3vw, 3rem)`. Product titles remain readable
  Inter, 0.95-1.1rem, with no more than four visible lines on narrow cards.
- Prefer sentence/title case. Short sports overlines may use modest tracking.

## Homepage structural anchor

- Maximum content width: 1200-1280px, with generous responsive gutters.
- Header: exact logo and wordmark at left, existing department navigation, and
  the current utility actions. A search affordance may be added without turning
  the header into an analytics or application toolbar.
- Hero: grass background, large rounded translucent panels, the existing value
  proposition, guarantee, exact DJHC brand mark, Facebook connection, primary
  browse action, and the existing marketplace/account functions. The redesign
  should reduce height and competing emphasis while keeping this recognizable
  content architecture.
- Department section: retain the current broad category choices and image-led
  cards for sports cards, comics, memorabilia, and hobby finds.
- Featured section: retain the real featured products, actual-item photography,
  factual titles, prices, details, wishlist, offer, and purchase capabilities.
  Improve visual rhythm and action hierarchy without inventing inventory.
- Footer: preserve the exact logo, established navigation, policies, marketplace
  links, and contact path in the same navy-led identity.

## Improvement boundaries

- Make the first shopping decision clearer: search or browse inventory first;
  marketplace, account, social, selling, and tool promotions may become quieter
  or move lower without being deleted.
- Reduce excessive hero height and repeated card emphasis, but retain the grass,
  dual-panel concept, current content, and existing visual identity.
- Use the homepage's current rounded cards and translucent surfaces selectively
  so primary content stands out. Do not substitute an archival-publication grid,
  a dense stats interface, or a generic ecommerce template.
- Product discovery remains image-led. Desktop cards use a consistent grid and
  mobile cards preserve large imagery and comfortable actions.
- Product detail remains a spacious dialog with large front image, optional back
  thumbnails, collector facts, price, availability, trust information, and one
  primary next action.

## Product-card anatomy

1. Large true-item image with calm framing and no decorative crop that hides the
   card, comic, slab label, signature, or memorabilia details.
2. Compact category/year/set or publisher line.
3. Descriptive title, then only verified collector chips such as RC, AUTO,
   memorabilia, graded, short print, parallel, or serial number.
4. Price and inventory state.
5. Clear action hierarchy: View details first, then one context-appropriate buy,
   offer, or inquiry action; wishlist remains a recognizable secondary control.

Collector-native filters may include sport/category, athlete, team, year,
set/brand, card type, graded/raw, grader, grade, price, autograph, memorabilia,
rookie, parallel, and serial-numbered. Applied filters must be visible and easy
to remove. Never show unavailable facts or fabricate population/sales data.

## Components and interaction

- Primary buttons: brand blue, 12-14px radius, 46-52px minimum height.
- Decisive commerce action may use DJHC red; do not make every action red.
- Secondary actions: white or warm paper, blue/navy text, thin border.
- Surfaces: preserve the homepage's rounded panels and cards, typically 12-24px
  radii, thin borders, translucent fills where the grass remains visible, and
  restrained shadows. Reduce pill repetition through hierarchy and spacing, not
  by importing a different visual system.
- Hover/focus movement is 1-3px and 160-220ms. Never animate continuously.
- Provide visible focus, reduced-motion behavior, labelled controls, meaningful
  product-image alt text, and at least 24px targets (prefer 44px for primary use).

## Trust and conversion

- Place truthful trust details near the item action: actual-item photography,
  careful packing, shipping estimate/link, returns link, secure Stripe handoff,
  and a direct way to ask DJ.
- Do not imply third-party authentication, guaranteed value, grading, or
  population data unless the individual listing has verified support.
- Keep guest browsing and checkout prominent; account benefits are optional.
- If checkout leaves the site for Stripe, make the transition explicit and
  visually intentional.

## Responsive behavior

- At about 1180px, collapse the full navigation without hiding search intent.
- At 900px, move to single-column feature sections and two-column product cards
  where width permits.
- At 700px and below, use a compact header, 1-2 product columns depending on
  content width, filter drawer, sticky contextual actions only when they do not
  obscure content, and no horizontal overflow at 320px.
- Preserve 44px preferred touch targets, clear focus, and readable labels.

## Homepage-only source boundary

Lineup Lab is relevant only as the existing secondary promotional card displayed
on the homepage. Its application shell, analytics layout, dense data views,
component structure, and styling are excluded from this storefront design system
and must not influence the homepage redesign.
