/**
 * Structured-data helpers for rendered product detail URLs.
 * ---------------------------------------------------------------------------
 * Static page JSON-LD lives in each HTML head. This runtime helper adds the
 * item-level Product/Offer graph when a product details modal is opened.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const SITE_URL = 'https://www.djshouseofcards-comics.com/';
  const SITE_EMAIL = 'djscardscomics13@gmail.com';
  const PRODUCT_SCHEMA_SCRIPT_ID = 'seo-product-structured-data';
  const PRODUCT_LINK_PARAM = 'item';

  function absoluteUrl(path = '') {
    try {
      return new URL(path, SITE_URL).toString();
    } catch (error) {
      return SITE_URL;
    }
  }

  function cleanText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function cleanGraph(value) {
    if (Array.isArray(value)) {
      return value
        .map(cleanGraph)
        .filter((item) => item !== undefined && item !== null && item !== '');
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, item]) => [key, cleanGraph(item)])
          .filter(([, item]) => (
            item !== undefined
            && item !== null
            && item !== ''
            && (!Array.isArray(item) || item.length)
          ))
      );
    }

    return value;
  }

  function productPagePath(product = {}) {
    if (typeof DJ.productPageUrl === 'function') {
      return DJ.productPageUrl(product);
    }

    const category = String(product.category || '').toLowerCase();
    const page = category.includes('baseball')
      ? 'baseball-cards.html'
      : category.includes('basketball')
        ? 'basketball-cards.html'
        : category.includes('football')
          ? 'football-cards.html'
          : category.includes('comic')
            ? 'comics.html'
            : category.includes('collect')
              ? 'collectibles.html'
              : 'shop.html';
    const productId = Number(product.id);
    return Number.isFinite(productId) && productId > 0
      ? `${page}?${PRODUCT_LINK_PARAM}=${encodeURIComponent(String(productId))}`
      : page;
  }

  function productUrl(product = {}) {
    return absoluteUrl(productPagePath(product));
  }

  function imageUrls(product = {}) {
    const gallery = Array.isArray(product.imageGallery) && product.imageGallery.length
      ? product.imageGallery
      : [product.image];

    return [...new Set(gallery
      .map((image) => absoluteUrl(image))
      .filter(Boolean))];
  }

  function productDescription(product = {}) {
    const explicitDescription = cleanText(product.description);
    if (explicitDescription) return explicitDescription;

    const details = [
      cleanText(product.yearLabel || product.year),
      cleanText(product.conditionCompact || product.condition),
      cleanText(product.sport || product.category),
      cleanText(product.team),
      cleanText(product.playerAthlete)
    ].filter(Boolean);

    const summary = details.length
      ? `${product.name} listing with ${details.join(', ')}.`
      : `${product.name} listing.`;

    return `${summary} Please review the photos and contact DJ with item-specific questions.`;
  }

  function offerPrice(product = {}) {
    const price = typeof DJ.payablePrice === 'function'
      ? DJ.payablePrice(product)
      : Number(product.price);
    return Number.isFinite(price) && price >= 0
      ? Number(price.toFixed(2))
      : null;
  }

  function offerAvailability(product = {}) {
    const statusText = [
      product.availability,
      product.status,
      product.displayPrice,
      product.priceLabel
    ].map((item) => String(item || '').toLowerCase()).join(' ');

    if (/\bsold\b|out of stock|unavailable/.test(statusText)) {
      return 'https://schema.org/OutOfStock';
    }

    return 'https://schema.org/InStock';
  }

  function productCategoryPath(product = {}) {
    const category = cleanText(product.category || product.sport || 'Collectibles');
    const lowerCategory = category.toLowerCase();

    if (['baseball', 'basketball', 'football'].includes(lowerCategory)) {
      return [
        ['Home', '/'],
        ['Sports Cards', '/sports-cards.html'],
        [category, productPagePath({ category })]
      ];
    }

    if (lowerCategory.includes('comic')) {
      return [
        ['Home', '/'],
        ['Comics', '/comics.html']
      ];
    }

    if (lowerCategory.includes('collect') || lowerCategory.includes('other')) {
      return [
        ['Home', '/'],
        ['Collectibles', '/collectibles.html']
      ];
    }

    return [
      ['Home', '/'],
      ['Shop Departments', '/shop.html']
    ];
  }

  function productBreadcrumb(product = {}, url = productUrl(product)) {
    const items = [
      ...productCategoryPath(product),
      [cleanText(product.name || 'Catalog item'), url]
    ];

    return {
      '@type': 'BreadcrumbList',
      '@id': `${url}#breadcrumb`,
      itemListElement: items.map(([name, path], index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name,
        item: /^https?:\/\//i.test(path) ? path : absoluteUrl(path)
      }))
    };
  }

  function productSchema(product = {}) {
    const url = productUrl(product);
    const price = offerPrice(product);
    const offer = {
      '@type': 'Offer',
      '@id': `${url}#offer`,
      url,
      price,
      priceCurrency: price == null ? undefined : 'USD',
      availability: offerAvailability(product),
      itemCondition: 'https://schema.org/UsedCondition',
      seller: {
        '@id': `${SITE_URL}#localbusiness`
      }
    };

    return cleanGraph({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Product',
          '@id': `${url}#product`,
          url,
          name: cleanText(product.name || 'Catalog item'),
          description: productDescription(product),
          image: imageUrls(product),
          sku: product.id == null ? undefined : `DJHC-${product.id}`,
          category: cleanText(product.category || product.sport),
          offers: {
            '@id': `${url}#offer`
          }
        },
        offer,
        productBreadcrumb(product, url)
      ]
    });
  }

  function upsertProductStructuredData(product = {}) {
    if (!product || !cleanText(product.name) || typeof document === 'undefined') return;

    let script = document.getElementById(PRODUCT_SCHEMA_SCRIPT_ID);
    if (!script) {
      script = document.createElement('script');
      script.id = PRODUCT_SCHEMA_SCRIPT_ID;
      script.type = 'application/ld+json';
      document.head.appendChild(script);
    }

    script.textContent = JSON.stringify(productSchema(product));
  }

  function removeProductStructuredData() {
    if (typeof document === 'undefined') return;
    document.getElementById(PRODUCT_SCHEMA_SCRIPT_ID)?.remove();
  }

  DJ.seo = {
    absoluteUrl,
    productSchema,
    upsertProductStructuredData,
    removeProductStructuredData
  };
})();
