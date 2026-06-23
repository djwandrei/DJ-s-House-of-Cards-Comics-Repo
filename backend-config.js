/**
 * Backend configuration
 * -----------------------------------------------------------------------------
 * Browser-safe public config only. Never put a service-role key in this file.
 */

(() => {
  const origin = window.location.origin;
  const isUsableOrigin =
    typeof origin === 'string' &&
    origin &&
    origin !== 'null' &&
    !origin.startsWith('file:');

  window.DJ_BACKEND_CONFIG = {
    enabled: true,
    provider: 'supabase',
    supabaseUrl: 'https://gkqdymnmczabcggvigce.supabase.co',
    supabasePublishableKey: 'sb_publishable_BHrJWQtop2ovkpOMOd9w3A_-9MTaeGG',
    productsTable: 'products',
    storageBucket: 'product-images',
    imageFolder: 'products',
    stripeCheckoutEnabled: true,
    stripeCheckoutFunction: 'create-checkout-session',
    // Supabase is preferred for fresh storefront data; deploy-synced JSON
    // snapshots remain the fast fallback when the backend is unavailable.
    preferStaticCatalog: false,
    remoteCatalogTimeoutMs: 3200,
    staticCatalogFallbackDelayMs: 350,
    siteUrl: isUsableOrigin ? origin : 'https://www.djshouseofcards-comics.com'
  };
})();


