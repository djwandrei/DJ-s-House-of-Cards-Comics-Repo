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
    // Public, read-only NBA analytics project. It is intentionally separate
    // from the commerce catalog/auth project above.
    analyticsSupabaseUrl: 'https://fbbmuqbdpgsmvnezowwn.supabase.co',
    analyticsSupabasePublishableKey: 'sb_publishable_ZZUUmm65NYHiRtUBHNW0sg_eJXE6KV2',
    productsTable: 'products',
    storefrontProductsTable: 'storefront_products',
    storageBucket: 'product-images',
    imageFolder: 'products',
    stripeCheckoutEnabled: true,
    stripeCheckoutFunction: 'create-checkout-session',
    checkoutSessionStatusFunction: 'checkout-session-status',
    // Guest holds use a server-side IP fingerprint, email limit, and global
    // concurrency cap so changing a guest email cannot bypass reservations.
    stripeGuestCheckoutEnabled: true,
    collectorInquiryFunction: 'collector-inquiry',
    offerWorkflowFunction: 'offer-workflow',
    analyticsEventFunction: 'analytics-event',
    measurementEnabled: true,
    measurementAllowedOrigins: [
      'https://www.djshouseofcards-comics.com',
      'https://djshouseofcards-comics.com'
    ],
    // Supabase is preferred for fresh storefront data; deploy-synced JSON
    // snapshots remain the fast fallback when the backend is unavailable.
    preferStaticCatalog: false,
    remoteCatalogTimeoutMs: 3200,
    staticCatalogFallbackDelayMs: 350,
    siteUrl: isUsableOrigin ? origin : 'https://www.djshouseofcards-comics.com'
  };
})();


