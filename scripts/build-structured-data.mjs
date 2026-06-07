import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SITE_URL = 'https://www.djshouseofcards-comics.com/';
const SITE_NAME = "DJ's House of Cards & Comics";
const SITE_EMAIL = 'djscardscomics13@gmail.com';
const SITE_LOGO = `${SITE_URL}assets/dj-logo.png`;
const FACEBOOK_URL = 'https://www.facebook.com/DJCardsComics/';
const SITE_DESCRIPTION = 'Curated sports cards, comics, and collectibles for buyers who enjoy the hunt.';
const SCRIPT_VERSION = '20260607d';
const pages = {
  'index.html': {
    type: 'WebPage',
    path: '/',
    name: "Sports Cards, Comics & Collectibles | DJ's House of Cards & Comics",
    description: "Shop vintage sports cards, graded favorites, Bronze Age comics, autographs, relics, and collectible finds at DJ's House of Cards & Comics.",
    image: 'assets/dj-logo.png'
  },
  'shop.html': {
    type: 'CollectionPage',
    path: '/shop.html',
    name: "Shop Sports Cards, Comics & Collectibles | DJ's House of Cards & Comics",
    description: "Browse sports cards, comics, and collectibles by department at DJ's House of Cards & Comics.",
    image: 'assets/baseball-main.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Shop Departments', '/shop.html']
    ]
  },
  'sports-cards.html': {
    type: 'CollectionPage',
    path: '/sports-cards.html',
    name: "Sports Cards by Sport | DJ's House of Cards & Comics",
    description: "Browse sports cards by sport at DJ's House of Cards & Comics. Start with baseball, basketball, or football and then filter by player, year, condition, and price.",
    image: 'assets/baseball-main.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Sports Cards', '/sports-cards.html']
    ]
  },
  'baseball-cards.html': {
    type: 'CollectionPage',
    path: '/baseball-cards.html',
    name: "Baseball Cards for Sale | DJ's House of Cards & Comics",
    description: "Shop baseball cards at DJ's House of Cards & Comics. Browse vintage stars, rookies, graded cards, and more with filters for year, condition, and price.",
    image: 'assets/baseball-main.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Sports Cards', '/sports-cards.html'],
      ['Baseball', '/baseball-cards.html']
    ]
  },
  'basketball-cards.html': {
    type: 'CollectionPage',
    path: '/basketball-cards.html',
    name: "Basketball Cards for Sale | DJ's House of Cards & Comics",
    description: "Shop basketball cards at DJ's House of Cards & Comics. Browse rookies, legends, inserts, autos, and modern cards with filters for year, condition, and price.",
    image: 'assets/basketball-main.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Sports Cards', '/sports-cards.html'],
      ['Basketball', '/basketball-cards.html']
    ]
  },
  'football-cards.html': {
    type: 'CollectionPage',
    path: '/football-cards.html',
    name: "Football Cards for Sale | DJ's House of Cards & Comics",
    description: "Shop football cards at DJ's House of Cards & Comics. Browse rookies, Hall of Famers, autos, patches, and more with filters for year, condition, and price.",
    image: 'assets/football-main.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Sports Cards', '/sports-cards.html'],
      ['Football', '/football-cards.html']
    ]
  },
  'comics.html': {
    type: 'CollectionPage',
    path: '/comics.html',
    name: "Comic Books for Sale | DJ's House of Cards & Comics",
    description: "Shop comic books at DJ's House of Cards & Comics. Browse keys, Bronze Age issues, fan favorites, and collectible comics with focused filtering tools.",
    image: 'assets/comics-main.jpeg',
    breadcrumb: [
      ['Home', '/'],
      ['Comics', '/comics.html']
    ]
  },
  'collectibles.html': {
    type: 'CollectionPage',
    path: '/collectibles.html',
    name: "Collectibles & Memorabilia | DJ's House of Cards & Comics",
    description: "Browse collectibles and memorabilia at DJ's House of Cards & Comics, including hobby finds, autos, display pieces, and more.",
    image: 'assets/Jordan.jpg',
    breadcrumb: [
      ['Home', '/'],
      ['Collectibles', '/collectibles.html']
    ]
  },
  'about.html': {
    type: 'AboutPage',
    path: '/about.html',
    name: "About DJ's House of Cards & Comics",
    description: "Get to know the collecting focus behind DJ's House of Cards & Comics, from vintage graded stars and modern autos to Bronze Age comics and memorabilia.",
    image: 'assets/dj-logo.png',
    breadcrumb: [
      ['Home', '/'],
      ['About', '/about.html']
    ]
  },
  'contact.html': {
    type: 'ContactPage',
    path: '/contact.html',
    name: "Contact DJ's House of Cards & Comics",
    description: "Contact DJ's House of Cards & Comics for buying inquiries, trades, questions, and collector-to-collector conversations.",
    image: 'assets/dj-logo.png',
    breadcrumb: [
      ['Home', '/'],
      ['Contact', '/contact.html']
    ],
    faq: [
      [
        'How do I ask about a specific card, comic, or collectible?',
        'Open the item details, copy the listing link or include the Listing ID, then send it through the contact form or email DJ directly.'
      ],
      [
        'Can I ask about trades or selling a collection?',
        'Yes. Share the item type, year, condition, photos if available, and whether you want to sell, trade, or consign.'
      ],
      [
        'Does the site take payment automatically?',
        'Eligible listings can use secure checkout when available. If checkout is unavailable or an item needs confirmation, the site opens an email inquiry so availability can be confirmed first.'
      ],
      [
        'How quickly does DJ respond?',
        'Most questions and purchase inquiries receive a reply within 24 hours.'
      ]
    ]
  },
  'wishlist.html': {
    type: 'WebPage',
    path: '/wishlist.html',
    name: "Wishlist | DJ's House of Cards & Comics",
    description: "View the cards, comics, and collectibles you have saved at DJ's House of Cards & Comics.",
    image: 'assets/dj-logo.png',
    breadcrumb: [
      ['Home', '/'],
      ['Wishlist', '/wishlist.html']
    ]
  },
  'account.html': {
    type: 'WebPage',
    path: '/account.html',
    name: "Account | DJ's House of Cards & Comics",
    description: "Review your wishlist and save optional buyer notes locally at DJ's House of Cards & Comics.",
    image: 'assets/dj-logo.png',
    breadcrumb: [
      ['Home', '/'],
      ['Account', '/account.html']
    ]
  },
  'admin.html': {
    type: 'WebPage',
    path: '/admin.html',
    name: "Admin Dashboard | DJ's House of Cards & Comics",
    description: "Admin dashboard for managing a Supabase-backed product catalog on DJ's House of Cards & Comics.",
    image: 'assets/dj-logo.png',
    breadcrumb: [
      ['Home', '/'],
      ['Admin', '/admin.html']
    ]
  }
};

function absoluteUrl(path) {
  return new URL(path, SITE_URL).toString();
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
        .filter(([, item]) => item !== undefined && item !== null && item !== '' && (!Array.isArray(item) || item.length))
    );
  }

  return value;
}

function buildOrganization() {
  return {
    '@type': 'Organization',
    '@id': `${SITE_URL}#organization`,
    name: SITE_NAME,
    url: SITE_URL,
    logo: SITE_LOGO,
    image: SITE_LOGO,
    email: SITE_EMAIL,
    description: SITE_DESCRIPTION,
    sameAs: [FACEBOOK_URL],
    contactPoint: {
      '@type': 'ContactPoint',
      email: SITE_EMAIL,
      contactType: 'customer service',
      availableLanguage: 'English'
    }
  };
}

function buildLocalBusiness() {
  return {
    '@type': ['LocalBusiness', 'Store'],
    '@id': `${SITE_URL}#localbusiness`,
    name: SITE_NAME,
    url: SITE_URL,
    logo: SITE_LOGO,
    image: SITE_LOGO,
    email: SITE_EMAIL,
    description: SITE_DESCRIPTION,
    priceRange: '$$',
    sameAs: [FACEBOOK_URL],
    areaServed: {
      '@type': 'Country',
      name: 'United States'
    },
    parentOrganization: {
      '@id': `${SITE_URL}#organization`
    }
  };
}

function buildWebsite() {
  return {
    '@type': 'WebSite',
    '@id': `${SITE_URL}#website`,
    url: SITE_URL,
    name: SITE_NAME,
    description: "Shop vintage sports cards, graded favorites, Bronze Age comics, autographs, relics, and collectible finds at DJ's House of Cards & Comics.",
    publisher: {
      '@id': `${SITE_URL}#organization`
    },
    about: {
      '@id': `${SITE_URL}#localbusiness`
    },
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}sports-cards.html?search={search_term_string}`,
      'query-input': 'required name=search_term_string'
    }
  };
}

function buildBreadcrumb(page) {
  if (!page.breadcrumb?.length) return null;

  return {
    '@type': 'BreadcrumbList',
    '@id': `${absoluteUrl(page.path)}#breadcrumb`,
    itemListElement: page.breadcrumb.map(([name, path], index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name,
      item: absoluteUrl(path)
    }))
  };
}

function buildFaq(page) {
  if (!page.faq?.length) return null;

  return {
    '@type': 'FAQPage',
    '@id': `${absoluteUrl(page.path)}#faq`,
    url: `${absoluteUrl(page.path)}#faq`,
    name: 'Common buyer and seller questions',
    inLanguage: 'en-US',
    isPartOf: {
      '@id': `${absoluteUrl(page.path)}#webpage`
    },
    mainEntity: page.faq.map(([question, answer]) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: answer
      }
    }))
  };
}

function buildPageGraph(page) {
  const pageUrl = absoluteUrl(page.path);
  const webPage = {
    '@type': page.type,
    '@id': `${pageUrl}#webpage`,
    url: pageUrl,
    name: page.name,
    description: page.description,
    isPartOf: {
      '@id': `${SITE_URL}#website`
    },
    about: {
      '@id': `${SITE_URL}#localbusiness`
    },
    publisher: {
      '@id': `${SITE_URL}#organization`
    },
    primaryImageOfPage: absoluteUrl(page.image),
    image: absoluteUrl(page.image),
    breadcrumb: page.breadcrumb?.length ? {
      '@id': `${pageUrl}#breadcrumb`
    } : undefined,
    hasPart: page.faq?.length ? {
      '@id': `${pageUrl}#faq`
    } : undefined,
    inLanguage: 'en-US'
  };

  return cleanGraph({
    '@context': 'https://schema.org',
    '@graph': [
      buildOrganization(),
      buildLocalBusiness(),
      buildWebsite(),
      webPage,
      buildBreadcrumb(page),
      buildFaq(page)
    ]
  });
}

function replaceStructuredData(html, graph) {
  const serialized = JSON.stringify(graph);
  const replacement = `<script id="seo-structured-data" type="application/ld+json">${serialized}</script>`;
  const pattern = /<script\s+id=["']seo-structured-data["']\s+type=["']application\/ld\+json["']>[\s\S]*?<\/script>/;

  if (pattern.test(html)) {
    return html.replace(pattern, () => replacement);
  }

  return html.replace('</head>', `${replacement}\n</head>`);
}

function ensureSeoRuntime(html) {
  if (html.includes('src="seo.js')) return html;

  return html.replace(
    /(<script\b[^>]*\bsrc=["']core\.js(?:\?v=[^"']+)?["'][^>]*>\s*<\/script>)/,
    `$1\n<script defer="" src="seo.js?v=${SCRIPT_VERSION}"></script>`
  );
}

for (const [fileName, page] of Object.entries(pages)) {
  const filePath = join(process.cwd(), fileName);
  const html = readFileSync(filePath, 'utf8');
  const nextHtml = ensureSeoRuntime(replaceStructuredData(html, buildPageGraph(page)));
  writeFileSync(filePath, nextHtml, 'utf8');
  console.log(`Updated ${fileName}`);
}
