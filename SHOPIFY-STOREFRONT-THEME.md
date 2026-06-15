# Shopify Storefront Theme Handoff

This is the Shopify theme direction for making the Shopify storefront resemble
the DJ's House of Cards website. The current sync app has product and inventory
scopes only, so live theme publishing should happen through Shopify Admin's
theme editor or after adding theme scopes in a reviewed app version.

## Design Brief

- Match the existing DJHC website, not a generic card-shop template.
- Keep the store trustworthy and checkout-oriented: clear category entry points,
  product imagery first, strong inventory status, and low-friction cart access.
- Preserve legacy listings as Shopify Draft products. Only reviewed non-legacy
  products should be candidates for channel publication.

## Brand Tokens

- Blue: `#1f2fa3`
- Dark blue: `#15206b`
- Red: `#ef1823`
- Dark red: `#b40f18`
- Gold: `#e4b141`
- Green/success: `#1b8d3d`
- Background light: `#f3f6fb`
- Surface light: `#ffffff`
- Text: `#172033`
- Muted text: `#5c667f`
- Radius: `22px`
- Display font: `Bebas Neue`
- Script logo/accent font: `Lobster Two`
- Body font: `Inter`

## Theme Editor Setup

1. Start from Dawn or another lightweight Shopify 2.0 theme.
2. Upload the DJHC logo and use the existing site lockup language:
   `DJ's House of Cards & Comics` and `Trusted Hobby Finds`.
3. Configure navigation:
   `Sports Cards`, `Comics`, `Collectibles`, `Wishlist`, `Cart`, `Account`.
4. Set homepage sections in this order:
   hero, featured category cards, newest non-legacy listings, value/trust block,
   newsletter/contact, footer.
5. Use collections for `Baseball Cards`, `Basketball Cards`, `Football Cards`,
   `Comics`, `Collectibles`, and `New Arrivals`.
6. Keep cart style as drawer or page, not popup-only, so multi-item checkout is
   obvious.
7. Add policy links in the footer: Shipping, Returns, Privacy, Terms.

## Custom CSS Starter

Paste this into the theme custom CSS area as the first pass, then tune against
the rendered theme:

```css
:root {
  --djhc-blue: #1f2fa3;
  --djhc-blue-dark: #15206b;
  --djhc-red: #ef1823;
  --djhc-gold: #e4b141;
  --djhc-bg: #f3f6fb;
  --djhc-text: #172033;
  --djhc-radius: 22px;
}

body {
  background:
    radial-gradient(circle at top left, rgba(31, 47, 163, .08), transparent 34%),
    radial-gradient(circle at top right, rgba(239, 24, 35, .08), transparent 28%),
    linear-gradient(180deg, #f8fbff 0, #eef3fb 100%);
  color: var(--djhc-text);
}

.button,
.shopify-payment-button__button,
.product-form__submit {
  border-radius: 999px;
  background: linear-gradient(135deg, var(--djhc-blue), var(--djhc-red));
  box-shadow: 0 14px 28px rgba(31, 47, 163, .22);
}

.card,
.product-card-wrapper,
.collection-card-wrapper,
.banner,
.multicolumn-card {
  border-radius: var(--djhc-radius);
  border: 1px solid rgba(24, 37, 73, .12);
  box-shadow: 0 12px 30px rgba(16, 27, 57, .14);
}

.header-wrapper,
.footer {
  background: linear-gradient(90deg, var(--djhc-blue-dark), var(--djhc-blue));
}

.header__menu-item,
.footer a {
  color: #fff;
}

.badge,
.price {
  color: var(--djhc-red);
}
```

## Go-Live Rules

- Run `node .\scripts\verify-shopify-sync.mjs` before connecting or publishing
  TikTok/Whatnot products.
- Do not publish legacy listings. They must remain Draft.
- Do not expand the Shopify sync app to theme scopes without creating a new
  reviewed app version and reauthorizing it.
