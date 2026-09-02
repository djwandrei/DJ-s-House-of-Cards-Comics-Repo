// Narrow, evidence-backed exceptions for catalog text that does not match the
// spelling or historical name used by the provider's stable player identifier.
//
// These are mapping inputs only. They never alter products.json, a workbook, or
// a live table. A provider ID is still required to exist in the local source
// cache, and the private preflight remains the final identity authority.

export const REVIEWED_CATALOG_ALIAS_OVERRIDES = Object.freeze([
  // MLB historical names, punctuation, suffixes, and verified catalog typos.
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Hank Aaron', providerExternalId: 'aaronha01', evidence: 'Historical given-name variant; local provider cache identifies Henry Aaron as aaronha01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Ed Mathews', providerExternalId: 'matheed01', evidence: 'Historical given-name variant; local provider cache identifies Eddie Mathews as matheed01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Eddie Mathews Jr.', providerExternalId: 'matheed01', evidence: 'Card-title suffix differs from local provider canonical Eddie Mathews.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Bill Ripken', providerExternalId: 'ripkebi01', evidence: 'Common given-name variant; local provider cache identifies Billy Ripken as ripkebi01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Barry Bonds Xrc', providerExternalId: 'bondsba01', evidence: 'Catalog player text includes the card designation XRC; local provider cache identifies Barry Bonds as bondsba01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Joe M. Morgan', providerExternalId: 'morgajo01', evidence: 'Middle initial and 1960 Kansas City Athletics card context distinguish the 1959-64 Joe Morgan from the later namesake.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Ji-Man Choi', providerExternalId: 'choiji01', evidence: 'Provider uses Jiman Choi; same player and local provider identity choiji01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Jonathan Gray', providerExternalId: 'grayjo02', evidence: 'Card uses Jonathan Gray; local provider cache identifies the same player as Jon Gray (grayjo02).' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Taylor Jungman', providerExternalId: 'jungmta01', evidence: 'Single-letter catalog transcription variant of local provider Taylor Jungmann.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Phillip Ervin', providerExternalId: 'ervinph01', evidence: 'Full-given-name variant; local provider cache identifies Phil Ervin as ervinph01.' },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'Mike Stanton', providerExternalId: 'stantmi03', evidence: "2011 Florida Marlins card uses the player's former public name; local provider cache identifies Giancarlo Stanton as stantmi03." },
  { leagueCode: 'MLB', sourceName: 'baseball_reference', sourcePlayerText: 'John Goryl', providerExternalId: 'goryljo01', evidence: 'Historical given-name variant; local provider cache identifies Johnny Goryl as goryljo01.' },
  // NFL historic naming variants. The initials case is also handled generically
  // by the initials-normalization index; retaining it here records the reviewed
  // catalog evidence for this card family.
  { leagueCode: 'NFL', sourceName: 'pro_football_reference', sourcePlayerText: 'Maurice Drew', providerExternalId: 'DrewMa00', evidence: "2006 Jacksonville card uses the player's pre-hyphenated public name; local provider cache identifies Maurice Jones-Drew as DrewMa00." },
  { leagueCode: 'NFL', sourceName: 'pro_football_reference', sourcePlayerText: 'Cj Prosise', providerExternalId: 'ProsC.00', evidence: 'Catalog omits periods from the local provider name C.J. Prosise.' },
]);

// Product-specific reviews have stronger evidence than a general title/name
// rule: either a local card image, manufacturer metadata, or both. The optional
// correction is deliberately proposal-only and is never consumed by the sync
// script, because catalog-field corrections need their own reviewed write.
export const REVIEWED_PRODUCT_IDENTITY_OVERRIDES = Object.freeze([
  {
    productId: 236, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Tony Gwynn', providerExternalId: 'gwynnto01',
    expectedProduct: {
      name: '2005 Upper Deck Classics Moments Materials #TG Tony Gwynn Jsy', playerAthlete: 'Tony Gwynn', team: 'San Diego Padres', year: 2005,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows the 3,000th-hit 8.6.99 Padres Tony Gwynn; this is the Hall of Fame player, not Tony Gwynn Jr.',
  },
  {
    productId: 981, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Adan Lind',
    providerExternalId: 'lindad01',
    expectedProduct: {
      name: '2012 Topps Tier One Adan Lind Crowd Pleaser Auto /399', playerAthlete: 'Adan Lind', team: '', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly reads Adam Lind and Toronto Blue Jays; catalog player text says Adan Lind.',
    proposedCatalogCorrections: { playerAthlete: 'Adam Lind', team: 'Toronto Blue Jays' },
  },
  {
    productId: 1033, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Eduardo Rodriquez',
    providerExternalId: 'rodried05',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Eduardo Rodriquez Rookie Refractor Auto', playerAthlete: 'Eduardo Rodriquez', team: '', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly reads Eduardo Rodriguez; catalog player text contains a transposed spelling.',
    proposedCatalogCorrections: { playerAthlete: 'Eduardo Rodriguez' },
  },
  {
    productId: 907, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Taylor Jungman', providerExternalId: 'jungmta01',
    expectedProduct: {
      name: '2011 Donruss Elite Extra Edition Taylor Jungman Aspirations Die-Cut /200', playerAthlete: 'Taylor Jungman', team: '', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly reads Taylor Jungmann and Milwaukee; catalog player text drops the final n.',
    proposedCatalogCorrections: { playerAthlete: 'Taylor Jungmann', team: 'Milwaukee Brewers' },
  },
  {
    productId: 977, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Liam Hendricks', providerExternalId: 'hendrli01',
    expectedProduct: {
      name: '2012 Topps Golden Moments Liam Hendricks SP Auto #GMA-LH', playerAthlete: 'Liam Hendricks', team: '', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly reads Liam Hendriks and Minnesota Twins; catalog player text has an extra c.',
    proposedCatalogCorrections: { playerAthlete: 'Liam Hendriks', team: 'Minnesota Twins' },
  },
  {
    productId: 890, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
    sourcePlayerText: 'Dexter Jackson',
    providerExternalId: 'JackDe01',
    expectedProduct: {
      name: '2008 Upper Deck Dexter Jackson Rookie Jersey Relic + Topps Progression RC Patch', playerAthlete: 'Dexter Jackson', team: '', year: 2008,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo and rookie-card evidence identify the 2008 Tampa Bay Dexter Jackson, not the earlier namesake.',
    proposedCatalogCorrections: { team: 'Tampa Bay Buccaneers' },
  },
  {
    productId: 1116, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
    sourcePlayerText: 'Michael Thomas',
    providerExternalId: 'ThomMi05',
    expectedProduct: {
      name: '2016 Panini Crown Royale Michael Thomas Rookie Silhouettes Patch /250', playerAthlete: 'Michael Thomas', team: 'Miami Dolphins', year: 2016,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly shows Michael Thomas in a New Orleans Saints uniform; stored Miami Dolphins team is incorrect.',
    proposedCatalogCorrections: { team: 'New Orleans Saints' },
  },
  {
    productId: 1146, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
    sourcePlayerText: 'Sydney Rice',
    providerExternalId: 'RiceSi01',
    expectedProduct: {
      name: '2019 Topps Unrivaled Sydney Rice /499', playerAthlete: 'Sydney Rice', team: '', year: 2019,
    },
    allowEvidenceConflict: true,
    evidence: 'Local product photo visibly reads Sidney Rice and Vikings WR; catalog spelling and blank team are incomplete.',
    proposedCatalogCorrections: { playerAthlete: 'Sidney Rice', team: 'Minnesota Vikings' },
  },
  {
    productId: 1203, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
    sourcePlayerText: 'Eddie George', providerExternalId: 'GeorEd00',
    expectedProduct: {
      name: '2021 Panini Score Eddie George Red Foil /460 #188', playerAthlete: 'Eddie George', team: 'Tennessee Titans', year: 2021,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card photo visibly identifies Eddie George in Tennessee Titans uniform despite the retrospective 2021 card year.',
  },
  // Retrospective MLB issues below retain correct player/team fields, but the
  // card-printing year follows the player's retirement. Each local image was
  // reviewed before permitting the narrowly scoped year-evidence exception.
  {
    productId: 118, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '1984 ASA Willie Mays 90 #60 Willie Mays/Bat in air over/left shoulder', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 1984,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Willie Mays in San Francisco Giants uniform on a retrospective 1984 issue.',
  },
  {
    productId: 119, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '1984 ASA Willie Mays 90 #23 Willie Mays/San Francisco Wins 1st Pennant', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 1984,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image and product title identify Willie Mays with the San Francisco Giants on a retrospective 1984 issue.',
  },
  {
    productId: 132, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Ernie Banks', providerExternalId: 'bankser01',
    expectedProduct: {
      name: '1989 Perez-Steele Celebration Postcards #3 Ernie Banks', playerAthlete: 'Ernie Banks', team: 'Chicago Cubs', year: 1989,
    },
    allowEvidenceConflict: true,
    evidence: 'Local postcard image visibly identifies Ernie Banks in Chicago Cubs uniform on a retrospective 1989 issue.',
  },
  {
    productId: 165, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Harmon Killebrew', providerExternalId: 'killeha01',
    expectedProduct: {
      name: '1999 Hillshire Farms Home Run Heroes Autographs #2 Harmon Killebrew', playerAthlete: 'Harmon Killebrew', team: 'Minnesota Twins', year: 1999,
    },
    allowEvidenceConflict: true,
    evidence: 'Local autograph card visibly identifies Harmon Killebrew and Minnesota on a retrospective 1999 issue.',
  },
  {
    productId: 166, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Harmon Killebrew', providerExternalId: 'killeha01',
    expectedProduct: {
      name: '1999 Hillshire Farms Home Run Heroes Autographs #2 Harmon Killebrew', playerAthlete: 'Harmon Killebrew', team: 'Minnesota Twins', year: 1999,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item photo visibly identifies Harmon Killebrew and Minnesota on a retrospective 1999 issue.',
  },
  {
    productId: 177, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie McCovey', providerExternalId: 'mccovwi01',
    expectedProduct: {
      name: '2001 Topps Archives Reserve Rookie Reprint Relics #ARR19 Willie McCovey Jsy', playerAthlete: 'Willie McCovey', team: 'San Francisco Giants', year: 2001,
    },
    allowEvidenceConflict: true,
    evidence: 'Local relic card visibly names Willie McCovey and San Francisco Giants on a rookie-reprint issue.',
  },
  {
    productId: 179, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Dave Parker', providerExternalId: 'parkeda01',
    expectedProduct: {
      name: '2002 SP Legendary Cuts Game Jersey #JDPA Dave Parker Pants DP', playerAthlete: 'Dave Parker', team: 'Pittsburgh Pirates', year: 2002,
    },
    allowEvidenceConflict: true,
    evidence: 'Local legendary game-jersey card visibly identifies Dave Parker and Pittsburgh Pirates on a retrospective 2002 issue.',
  },
  {
    productId: 180, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Dave Parker', providerExternalId: 'parkeda01',
    expectedProduct: {
      name: '2002 SP Legendary Cuts Game Jersey #JDPA Dave Parker Pants DP', playerAthlete: 'Dave Parker', team: 'Pittsburgh Pirates', year: 2002,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item photo visibly identifies Dave Parker and Pittsburgh Pirates on a retrospective 2002 issue.',
  },
  {
    productId: 185, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Dave Winfield', providerExternalId: 'winfida01',
    expectedProduct: {
      name: '2003 Flair Greats #58 Dave Winfield', playerAthlete: 'Dave Winfield', team: 'San Diego Padres', year: 2003,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Flair Greats image visibly identifies Dave Winfield in San Diego Padres uniform on a retrospective 2003 issue.',
  },
  {
    productId: 186, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jerry Lumpe', providerExternalId: 'lumpeje01',
    expectedProduct: {
      name: '2003 Upper Deck Yankees Signature Pride of New York Autographs #JL Jerry Lumpe', playerAthlete: 'Jerry Lumpe', team: 'New York Yankees', year: 2003,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Yankees Signature card visibly identifies Jerry Lumpe with New York Yankees on a retrospective 2003 autograph issue.',
  },
  {
    productId: 187, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jim Bouton', providerExternalId: 'boutoji01',
    expectedProduct: {
      name: '2003 Upper Deck Yankees Signature #40 Jim Bouton', playerAthlete: 'Jim Bouton', team: 'New York Yankees', year: 2003,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Yankees Signature card visibly identifies Jim Bouton with New York Yankees on a retrospective 2003 autograph issue.',
  },
  {
    productId: 211, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Paul Molitor', providerExternalId: 'molitpa01',
    expectedProduct: {
      name: '2004 Topps Tribute HOF Relics #PM Paul Molitor Jsy G', playerAthlete: 'Paul Molitor', team: 'Milwaukee Brewers', year: 2004,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Hall of Fame relic card visibly identifies Paul Molitor and Milwaukee Brewers on a retrospective 2004 issue.',
  },
  {
    productId: 214, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '2004 Topps All-Time Fan Favorites #1 Willie Mays', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 2004,
    },
    allowEvidenceConflict: true,
    evidence: 'Local All-Time Fan Favorites image visibly identifies Willie Mays and S.F. Giants on a retrospective 2004 issue.',
  },
  {
    productId: 215, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '2004 Topps Legends Autographs #WM Willie Mays BGS 8', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 2004,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps Legends autograph visibly identifies Willie Mays and San Francisco Giants on a retrospective 2004 issue.',
  },
  {
    productId: 235, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Sammy Sosa', providerExternalId: 'sosasa01',
    expectedProduct: {
      name: '2005 Playoff Prestige Playoff MLB Game-Worn Jersey Collection #15 Sammy Sosa', playerAthlete: 'Sammy Sosa', team: 'Chicago Cubs', year: 2005,
    },
    allowEvidenceConflict: true,
    evidence: 'Local game-worn jersey card visibly identifies Sammy Sosa and Chicago Cubs; the relic-team context differs from the provider’s 2005 season row.',
  },
  {
    productId: 250, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Alex Rodriguez', providerExternalId: 'rodrial01',
    expectedProduct: {
      name: '2007 Topps Alex Rodriguez Road to 500 #ARHR13 Alex Rodriguez', playerAthlete: 'Alex Rodriguez', team: 'Seattle Mariners', year: 2007,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Road to 500 card visibly identifies Alex Rodriguez and his 2000 Seattle Mariners home-run context; it is not a 2007 team assertion.',
  },
  {
    productId: 338, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Hank Aaron', providerExternalId: 'aaronha01',
    expectedProduct: {
      name: '2011 Topps Triple Threads #46 Hank Aaron', playerAthlete: 'Hank Aaron', team: 'Atlanta Braves', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Triple Threads card visibly identifies Hank Aaron and Atlanta Braves on a retrospective 2011 issue.',
  },
  {
    productId: 342, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jackie Robinson', providerExternalId: 'robinja02',
    expectedProduct: {
      name: '2011 Topps Triple Threads Legend Relics #TTRL8 Jackie Robinson', playerAthlete: 'Jackie Robinson', team: 'Brooklyn Dodgers', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Triple Threads relic visibly identifies Jackie Robinson and Brooklyn Dodgers on a retrospective 2011 issue.',
  },
  {
    productId: 349, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jim Palmer', providerExternalId: 'palmeji01',
    expectedProduct: {
      name: '2011 Topps Triple Threads Emerald #48 Jim Palmer', playerAthlete: 'Jim Palmer', team: 'Baltimore Orioles', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Triple Threads card visibly identifies Jim Palmer and Baltimore Orioles on a retrospective 2011 issue.',
  },
  {
    productId: 374, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mickey Mantle', providerExternalId: 'mantlmi01',
    expectedProduct: {
      name: '2011 Topps 60 #7 Mickey Mantle', playerAthlete: 'Mickey Mantle', team: 'New York Yankees', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps 60 card visibly identifies Mickey Mantle in New York Yankees uniform on a retrospective 2011 issue.',
  },
  {
    productId: 375, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mickey Mantle', providerExternalId: 'mantlmi01',
    expectedProduct: {
      name: '2011 Topps Allen and Ginter #7 Mickey Mantle', playerAthlete: 'Mickey Mantle', team: 'New York Yankees', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Allen and Ginter card visibly identifies Mickey Mantle in New York Yankees uniform on a retrospective 2011 issue.',
  },
  {
    productId: 382, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Rickey Henderson', providerExternalId: 'henderi01',
    expectedProduct: {
      name: '2011 Topps Glove Manufactured Leather Nameplates #RHE Rickey Henderson S2', playerAthlete: 'Rickey Henderson', team: 'Oakland Athletics', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local manufactured-leather nameplate visibly identifies Rickey Henderson #24; its Yankees-photo context is retrospective and does not independently prove the stored Oakland team.',
  },
  {
    productId: 387, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Tom Seaver', providerExternalId: 'seaveto01',
    expectedProduct: {
      name: '2011 Topps Triple Threads #84 Tom Seaver', playerAthlete: 'Tom Seaver', team: 'New York Mets', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Triple Threads card visibly identifies Tom Seaver and New York Mets uniform on a retrospective 2011 issue.',
  },
  {
    productId: 388, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Tom Seaver', providerExternalId: 'seaveto01',
    expectedProduct: {
      name: '2011 Topps Glove Manufactured Leather Nameplates #TS Tom Seaver UPD', playerAthlete: 'Tom Seaver', team: 'Cincinnati Reds', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local manufactured-leather nameplate visibly identifies Tom Seaver and Cincinnati Reds uniform context on a retrospective 2011 issue.',
  },
  {
    productId: 390, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie McCovey', providerExternalId: 'mccovwi01',
    expectedProduct: {
      name: '2011 Topps Triple Threads Sapphire #17 Willie McCovey', playerAthlete: 'Willie McCovey', team: 'San Francisco Giants', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Triple Threads Sapphire card visibly identifies Willie McCovey and San Francisco Giants uniform on a retrospective 2011 issue.',
  },
  {
    productId: 391, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie McCovey', providerExternalId: 'mccovwi01',
    expectedProduct: {
      name: '2011 Topps Triple Threads Sapphire #17 Willie McCovey', playerAthlete: 'Willie McCovey', team: 'San Francisco Giants', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item image visibly identifies Willie McCovey and San Francisco Giants uniform on a retrospective 2011 issue.',
  },
  {
    productId: 398, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Hank Aaron', providerExternalId: 'aaronha01',
    expectedProduct: {
      name: '2012 Topps Heritage Baseball Flashbacks #HA Hank Aaron', playerAthlete: 'Hank Aaron', team: 'Milwaukee Braves', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Heritage Baseball Flashbacks card visibly identifies Hank Aaron and Milwaukee Braves in its 1963 historical context.',
  },
  {
    productId: 403, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mickey Mantle', providerExternalId: 'mantlmi01',
    expectedProduct: {
      name: '2012 Topps Mini #7 Mickey Mantle', playerAthlete: 'Mickey Mantle', team: 'New York Yankees', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps Mini card visibly identifies Mickey Mantle in New York Yankees uniform on a retrospective 2012 issue.',
  },
  {
    productId: 407, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: "2012 Topps Heritage '63 Mint #63WM Willie Mays", playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Heritage 63 Mint card visibly identifies Willie Mays and San Francisco Giants in its 1963 historical context.',
  },
  {
    productId: 409, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Al Kaline', providerExternalId: 'kalinal01',
    expectedProduct: {
      name: '2014 Topps Tier One Acclaimed Autographs #AAAKL Al Kaline/299', playerAthlete: 'Al Kaline', team: 'Detroit Tigers', year: 2014,
    },
    allowEvidenceConflict: true,
    evidence: 'Local certified autograph card visibly identifies Al Kaline and Detroit Tigers uniform on a retrospective 2014 issue.',
  },
  {
    productId: 833, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Joe DiMaggio', providerExternalId: 'dimagjo01',
    expectedProduct: {
      name: '2010 Upper Deck Baseball Heroes #BH3 Joe DiMaggio', playerAthlete: 'Joe DiMaggio', team: 'New York Yankees', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Baseball Heroes card visibly identifies Joe DiMaggio and a 1940 New York Yankees context on a retrospective 2010 issue.',
  },
  {
    productId: 2845, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Sandy Koufax', providerExternalId: 'koufasa01',
    expectedProduct: {
      name: '2011 Topps 60 #57 Sandy Koufax', playerAthlete: 'Sandy Koufax', team: 'Los Angeles Dodgers', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps 60 card visibly identifies Sandy Koufax in Los Angeles Dodgers uniform on a retrospective 2011 issue.',
  },
  {
    productId: 2846, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jackie Robinson', providerExternalId: 'robinja02',
    expectedProduct: {
      name: '2011 Topps 60 #97 Jackie Robinson', playerAthlete: 'Jackie Robinson', team: 'Brooklyn Dodgers', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps 60 card visibly identifies Jackie Robinson in Brooklyn Dodgers uniform on a retrospective 2011 issue.',
  },
  {
    productId: 2851, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Johnny Bench', providerExternalId: 'benchjo01',
    expectedProduct: {
      name: '2011 Topps Gypsy Queen Home Run Heroes #HH20 Johnny Bench', playerAthlete: 'Johnny Bench', team: 'Cincinnati Reds', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Gypsy Queen card visibly identifies Johnny Bench and Cincinnati Reds uniform on a retrospective 2011 issue.',
  },
  {
    productId: 2884, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Roberto Clemente', providerExternalId: 'clemero01',
    expectedProduct: {
      name: '2012 Topps Golden Greats #GG36 Roberto Clemente', playerAthlete: 'Roberto Clemente', team: 'Pittsburgh Pirates', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Golden Greats card visibly identifies Roberto Clemente and Pittsburgh Pirates uniform on a retrospective 2012 issue.',
  },
  {
    productId: 2888, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '2012 Topps Retail Refractors #MBC2 Willie Mays', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local retail refractor visibly identifies Willie Mays and San Francisco Giants uniform on a retrospective 2012 issue.',
  },
  {
    productId: 2890, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '2012 Topps Allen and Ginter #210 Willie Mays', playerAthlete: 'Willie Mays', team: 'San Francisco Giants', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Allen and Ginter card visibly identifies Willie Mays in San Francisco Giants uniform on a retrospective 2012 issue.',
  },
  {
    productId: 2894, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jackie Robinson', providerExternalId: 'robinja02',
    expectedProduct: {
      name: '2012 Topps Allen and Ginter Mini Black #31 Jackie Robinson', playerAthlete: 'Jackie Robinson', team: 'Brooklyn Dodgers', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Allen and Ginter Mini Black card visibly identifies Jackie Robinson in Brooklyn Dodgers uniform on a retrospective 2012 issue.',
  },
  {
    productId: 258, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mickey Mantle', providerExternalId: 'mantlmi01',
    expectedProduct: {
      name: '2006 Topps Mantle Home Run History #249 Mickey Mantle', playerAthlete: 'Mickey Mantle', team: 'New York Yankees', year: 2006,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Home Run History card visibly identifies Mickey Mantle and New York Yankees on a retrospective 2006 issue.',
  },
  {
    productId: 297, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Nolan Ryan', providerExternalId: 'ryanno01',
    expectedProduct: {
      name: '2009 Topps Legends of the Game #LG24 Nolan Ryan', playerAthlete: 'Nolan Ryan', team: 'Houston Astros', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Legends of the Game card visibly identifies Nolan Ryan in Houston Astros uniform on a retrospective 2009 issue.',
  },
  {
    productId: 2929, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jackie Robinson', providerExternalId: 'robinja02',
    expectedProduct: {
      name: '2011 Topps Triple Threads Legend Relics #TTRL8 Jackie Robinson', playerAthlete: 'Jackie Robinson', team: 'Brooklyn Dodgers', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item relic visibly identifies Jackie Robinson and Brooklyn Dodgers on a retrospective 2011 issue.',
  },
  {
    productId: 2993, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Felipe Alou', providerExternalId: 'aloufe01',
    expectedProduct: {
      name: "2013 Topps Heritage '64 Buybacks #65 Felipe Alou", playerAthlete: 'Felipe Alou', team: 'Milwaukee Braves', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Heritage 64 Buybacks card visibly identifies Felipe Alou in Milwaukee Braves uniform on a retrospective 2013 issue.',
  },
  {
    productId: 3611, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mickey Mantle', providerExternalId: 'mantlmi01',
    expectedProduct: {
      name: '2007 Topps Mickey Mantle Home Run History #415 + #418 Set (x2)', playerAthlete: 'Mickey Mantle', team: 'New York Yankees', year: 2007,
    },
    allowEvidenceConflict: true,
    evidence: 'Local two-card Home Run History set visibly identifies Mickey Mantle and New York Yankees on a retrospective 2007 issue.',
  },
  // These are pre-debut prospect, national-team, or retrospective issues. The
  // card image establishes the player; the card year is intentionally not used
  // as a claim that the player appeared in an MLB season that year.
  {
    productId: 144, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Chipper Jones', providerExternalId: 'jonesch06',
    expectedProduct: {
      name: '1991 Score #671 Chipper Jones RC PSA 10', playerAthlete: 'Chipper Jones', team: 'Atlanta Braves', year: 1991,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded Score rookie visibly identifies Chipper Jones and Atlanta Braves as the first-round draft pick.',
  },
  {
    productId: 174, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Josh Hamilton', providerExternalId: 'hamiljo03',
    expectedProduct: {
      name: '2001 Topps Stars #167 Josh Hamilton', playerAthlete: 'Josh Hamilton', team: 'Tampa Bay Devil Rays', year: 2001,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Topps Stars card visibly identifies Josh Hamilton in Tampa Bay Devil Rays uniform before his MLB debut.',
  },
  {
    productId: 181, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Joe Mauer', providerExternalId: 'mauerjo01',
    expectedProduct: {
      name: '2002 Bowman #379 Joe Mauer RC', playerAthlete: 'Joe Mauer', team: 'Minnesota Twins', year: 2002,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman rookie visibly identifies Joe Mauer in Minnesota Twins uniform before his MLB debut.',
  },
  {
    productId: 290, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Bryce Harper', providerExternalId: 'harpebr03',
    expectedProduct: {
      name: '2009 Upper Deck Signature Stars USA By the Letter Autographs #BH Bryce Harper BGS 8.5', playerAthlete: 'Bryce Harper', team: 'Team USA', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded USA Baseball autograph visibly identifies Bryce Harper and Team USA before his MLB debut.',
  },
  {
    productId: 291, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Bryce Harper', providerExternalId: 'harpebr03',
    expectedProduct: {
      name: '2009 Upper Deck Signature Stars USA By the Letter Autographs #BH Bryce Harper', playerAthlete: 'Bryce Harper', team: 'Team USA', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local USA Baseball autograph visibly identifies Bryce Harper and Team USA before his MLB debut.',
  },
  {
    productId: 292, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Bryce Harper', providerExternalId: 'harpebr03',
    expectedProduct: {
      name: '2009 Upper Deck Signature Stars USA By the Letter Autographs #BH Bryce Harper', playerAthlete: 'Bryce Harper', team: 'Team USA', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item USA Baseball autograph visibly identifies Bryce Harper and Team USA before his MLB debut.',
  },
  {
    productId: 301, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Yu Darvish', providerExternalId: 'darviyu01',
    expectedProduct: {
      name: '2009 Bowman WBC Prospects #BW1 Yu Darvish', playerAthlete: 'Yu Darvish', team: 'Team Japan', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local WBC Prospects card visibly identifies Yu Darvish and Team Japan before his MLB debut.',
  },
  {
    productId: 302, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Yu Darvish', providerExternalId: 'darviyu01',
    expectedProduct: {
      name: '2009 Bowman Draft WBC Prospects #BDPW2 Yu Darvish', playerAthlete: 'Yu Darvish', team: 'Team Japan', year: 2009,
    },
    allowEvidenceConflict: true,
    evidence: 'Local WBC Draft Prospects card visibly identifies Yu Darvish and Team Japan before his MLB debut.',
  },
  {
    productId: 343, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jake Hager', providerExternalId: 'hagerja01',
    expectedProduct: {
      name: '2011 Bowman Sterling Prospect Autographs Gold Refractors #JH Jake Hager', playerAthlete: 'Jake Hager', team: 'Tampa Bay Rays', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Sterling autograph visibly identifies Jake Hager and Tampa Bay Rays prospect context before his MLB debut.',
  },
  {
    productId: 348, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jesse Winker', providerExternalId: 'winkeje01',
    expectedProduct: {
      name: '2011 USA Baseball Autographs #A70 Jesse Winker', playerAthlete: 'Jesse Winker', team: 'Team USA', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local USA Baseball autograph visibly identifies Jesse Winker and Team USA before his MLB debut.',
  },
  {
    productId: 350, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'John Hicks', providerExternalId: 'hicksjo02',
    expectedProduct: {
      name: '2011 Bowman Chrome Draft Prospects Purple Refractors #BDPP1 John Hicks', playerAthlete: 'John Hicks', team: 'Arizona Diamondbacks', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome Draft card visibly identifies John Hicks in Arizona Diamondbacks prospect context before his MLB debut.',
  },
  {
    productId: 360, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Kevin Gausman', providerExternalId: 'gausmke01',
    expectedProduct: {
      name: '2011 USA Baseball Autographs #A7 Kevin Gausman', playerAthlete: 'Kevin Gausman', team: 'Team USA', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local USA Baseball autograph visibly identifies Kevin Gausman and Team USA before his MLB debut.',
  },
  {
    productId: 361, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Manny Banuelos', providerExternalId: 'banuema01',
    expectedProduct: {
      name: '2011 Bowman Chrome Prospects Refractors #BCP133 Manny Banuelos', playerAthlete: 'Manny Banuelos', team: 'New York Yankees', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome prospect card visibly identifies Manny Banuelos and New York Yankees prospect context before his MLB debut.',
  },
  {
    productId: 364, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Mark Appel', providerExternalId: 'appelma01',
    expectedProduct: {
      name: '2011 USA Baseball Autographs #A1 Mark Appel', playerAthlete: 'Mark Appel', team: 'Team USA', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local USA Baseball autograph visibly identifies Mark Appel and Team USA before his MLB debut.',
  },
  {
    productId: 843, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Ryne Stanek', providerExternalId: 'stanery01',
    expectedProduct: {
      name: '2013 Elite Extra Edition Franchise Futures Signatures Red Ink #9 Ryne Stanek/25', playerAthlete: 'Ryne Stanek', team: 'Tampa Bay Rays', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Ryne Stanek and Tampa Bay Rays prospect context before his MLB debut.',
  },
  {
    productId: 865, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Bill Bray', providerExternalId: 'braybi01',
    expectedProduct: {
      name: '2004 Bowman Chrome Draft Prospects Bill Bray Refractor Rookie Auto #BDP173', playerAthlete: 'Bill Bray', team: 'Montreal Expos', year: 2004,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome Draft autograph visibly identifies Bill Bray before his MLB debut.',
  },
  {
    productId: 856, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Zach Sorensen', providerExternalId: 'sorenza01',
    expectedProduct: {
      name: '1997 Just Minors Zach Sorensen Limited Edition Rookie Auto SP', playerAthlete: 'Zach Sorensen', team: '', year: 1997,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Just Minors autograph visibly identifies Zach Sorensen; no card-facing professional team is claimed for this prospect issue.',
  },
  {
    productId: 898, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'A.J. Griffin', providerExternalId: 'griffaj01',
    expectedProduct: {
      name: '2010 Donruss Elite Extra Edition AJ Griffin Aspirations Die-Cut Auto /100', playerAthlete: 'A.J. Griffin', team: 'Oakland Athletics', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies A.J. Griffin and Oakland prospect context before his MLB debut.',
  },
  {
    productId: 2800, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Chrome Prospects Refractors #BCP205B Miguel Sano AU', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2801, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Chrome Prospects Refractors #BCP205B Miguel Sano AU', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Chrome prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2802, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Chrome Prospects Refractors #BCP205B Miguel Sano AU', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Chrome prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2803, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Chrome Prospects Refractors #BCP205B Miguel Sano AU', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Chrome prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2804, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Chrome Prospects Blue Refractors #BCP205B Miguel Sano AU', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome Blue prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2805, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Platinum Prospect Autographs Refractors #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Platinum prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2806, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Platinum Prospect Autographs Refractors #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Platinum prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2807, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Platinum Prospect Autographs Refractors #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Platinum prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2808, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Platinum Prospect Autographs Refractors #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Platinum prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2809, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2010 Bowman Platinum Prospect Autographs Refractors #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local duplicate-item Bowman Platinum prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2815, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Bryce Harper', providerExternalId: 'harpebr03',
    expectedProduct: {
      name: '2010 JUCO World Series #1 Bryce Harper PSA 9', playerAthlete: 'Bryce Harper', team: '', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded JUCO World Series card visibly identifies Bryce Harper before his MLB debut; its college team is intentionally left outside the MLB team vocabulary.',
  },
  {
    productId: 2835, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Dillon Maples', providerExternalId: 'mapledi01',
    expectedProduct: {
      name: '2011 Donruss Elite Extra Edition Franchise Futures Signatures #51 Dillon Maples', playerAthlete: 'Dillon Maples', team: 'Chicago Cubs', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Dillon Maples and Chicago Cubs prospect context before his MLB debut.',
  },
  {
    productId: 2909, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2013 Bowman Chrome Draft Top Prospects #TP45 Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome Draft Top Prospects card visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2910, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Byron Buxton', providerExternalId: 'buxtoby01',
    expectedProduct: {
      name: '2013 Bowman Chrome Draft Top Prospects Refractors #TP1 Byron Buxton PSA 10', playerAthlete: 'Byron Buxton', team: 'Minnesota Twins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded Bowman Chrome Draft Top Prospects card visibly identifies Byron Buxton and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2911, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Miguel Sano', providerExternalId: 'sanomi01',
    expectedProduct: {
      name: '2013 Bowman Sterling Prospect Autographs #MS Miguel Sano', playerAthlete: 'Miguel Sano', team: 'Minnesota Twins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Sterling prospect autograph visibly identifies Miguel Sano and Minnesota Twins before his MLB debut.',
  },
  {
    productId: 2919, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'John Goryl', providerExternalId: 'goryljo01',
    expectedProduct: {
      name: '2013 Topps Heritage Real One Autographs Red Ink #JG John Goryl', playerAthlete: 'John Goryl', team: 'Minnesota Twins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Heritage autograph visibly identifies John Goryl and Minnesota Twins on a retrospective 2013 issue.',
  },
  {
    productId: 3608, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Chipper Jones', providerExternalId: 'jonesch06',
    expectedProduct: {
      name: '1991 Score Chipper Jones Rookie #671', playerAthlete: 'Chipper Jones', team: 'Atlanta Braves', year: 1991,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Score rookie visibly identifies Chipper Jones and Atlanta Braves as the first-round draft pick.',
  },
  {
    productId: 935, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Oscar Taveras', providerExternalId: 'taveros01',
    expectedProduct: {
      name: '2012 Bowman Platinum Oscar Taveras Prospect Purple + Refractor Rookie Set', playerAthlete: 'Oscar Taveras', team: 'St. Louis Cardinals', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Platinum prospect cards visibly identify Oscar Taveras and St. Louis Cardinals context before his MLB debut.',
  },
  {
    productId: 940, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Trayce Thompson', providerExternalId: 'thomptr01',
    expectedProduct: {
      name: '2012 Bowman Trayce Thompson Prospect Auto Set (x2)', playerAthlete: 'Trayce Thompson', team: 'Chicago White Sox', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman prospect autograph set visibly identifies Trayce Thompson and Chicago White Sox context before his MLB debut.',
  },
  {
    productId: 944, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Collin Wiles', providerExternalId: 'wilesco01',
    expectedProduct: {
      name: '2012 Donruss Elite Extra Edition Collin Wiles Rookie Prospects Auto /622 #147', playerAthlete: 'Collin Wiles', team: 'Texas Rangers', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Collin Wiles and Texas Rangers prospect context before his MLB debut.',
  },
  {
    productId: 946, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Nick Williams', providerExternalId: 'willini01',
    expectedProduct: {
      name: '2012 Donruss Elite Extra Edition Nick Williams Aspirations Prospect Auto /100', playerAthlete: 'Nick Williams', team: 'Texas Rangers', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Nick Williams and Texas Rangers prospect context before his MLB debut.',
  },
  {
    productId: 949, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Richie Shaffer', providerExternalId: 'shaffri01',
    expectedProduct: {
      name: '2012 Donruss Elite Extra Edition Richie Shaffer Rookie Auto /722', playerAthlete: 'Richie Shaffer', team: 'Tampa Bay Rays', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Richie Shaffer and Tampa Bay Rays prospect context before his MLB debut.',
  },
  {
    productId: 1014, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Addison Russell', providerExternalId: 'russead02',
    expectedProduct: {
      name: '2013 Bowman Inception Addison Russell Rookie Prospect Auto BGS 9.5 Auto 10', playerAthlete: 'Addison Russell', team: 'Oakland Athletics', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded Bowman Inception autograph visibly identifies Addison Russell and Oakland Athletics prospect context before his MLB debut.',
  },
  {
    productId: 1026, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Trevor Williams', providerExternalId: 'willitr01',
    expectedProduct: {
      name: '2013 Bowman Sterling Trevor Williams Prospect Auto #BSAP-TWI', playerAthlete: 'Trevor Williams', team: 'Miami Marlins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Sterling autograph visibly identifies Trevor Williams and Miami Marlins prospect context before his MLB debut.',
  },
  {
    productId: 1030, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Travis Demeritte', providerExternalId: 'demertr01',
    expectedProduct: {
      name: '2013 Donruss Elite Extra Edition Travis Demeritte Aspirations Rookie Auto /200', playerAthlete: 'Travis Demeritte', team: 'Texas Rangers', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition autograph visibly identifies Travis Demeritte and Texas Rangers prospect context before his MLB debut.',
  },
  {
    productId: 1032, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Domingo Tapia', providerExternalId: 'tapiado01',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Domingo Tapia Rookie Refractor Auto', playerAthlete: 'Domingo Tapia', team: '', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Domingo Tapia before his MLB debut; no unsupported card-facing team is added.',
  },
  {
    productId: 1034, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Hunter Harvey', providerExternalId: 'harvehu01',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Hunter Harvey Purple Refractor Auto 1/50 + State Pride /25', playerAthlete: 'Hunter Harvey', team: 'Baltimore Orioles', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Hunter Harvey before his MLB debut; no unsupported card-facing team change is proposed.',
  },
  {
    productId: 1035, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jonathan Gray', providerExternalId: 'grayjo02',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Jonathan Gray Red Rookie Refractor Auto /5', playerAthlete: 'Jonathan Gray', team: '', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Jonathan Gray before his MLB debut; no unsupported card-facing team is added.',
  },
  {
    productId: 1037, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Phillip Ervin', providerExternalId: 'ervinph01',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Phillip Ervin Rookie Refractor Auto', playerAthlete: 'Phillip Ervin', team: '', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Phillip Ervin before his MLB debut; no unsupported card-facing team is added.',
  },
  {
    productId: 1038, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Ryan Eades', providerExternalId: 'eadesry01',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Ryan Eades Rookie Refractor Auto', playerAthlete: 'Ryan Eades', team: '', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Ryan Eades before his MLB debut; no unsupported card-facing team is added.',
  },
  {
    productId: 1040, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Tim Anderson', providerExternalId: 'anderti01',
    expectedProduct: {
      name: '2013 Leaf Metal Draft Tim Anderson Blue Rookie Refractor Auto /25', playerAthlete: 'Tim Anderson', team: 'Chicago White Sox', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Leaf Metal Draft autograph visibly identifies Tim Anderson before his MLB debut; no unsupported card-facing team change is proposed.',
  },
  {
    productId: 1085, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Jamie Westbrook', providerExternalId: 'westbja02',
    expectedProduct: {
      name: '2014 Bowman Jamie Westbrook 1st Prospect Auto Autograph', playerAthlete: 'Jamie Westbrook', team: 'Arizona Diamondbacks', year: 2014,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman first-prospect autograph visibly identifies Jamie Westbrook and Arizona Diamondbacks context before his MLB debut.',
  },
  {
    productId: 660, leagueCode: 'NFL', sourceName: 'pro_football_reference', subjectOrder: 1,
    sourcePlayerText: 'Lamar Miller', providerExternalId: 'MillLa01',
    expectedProduct: {
      name: '2016 Prime Signatures Prime Signature Swatches Blue #28 Lamar Miller/10', playerAthlete: 'Lamar Miller', team: 'Miami Dolphins', year: 2016,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Prime Signatures swatch card visibly identifies Lamar Miller in Miami Dolphins uniform; its card-facing team predates the provider’s 2016 Texans season row.',
  },
  {
    productId: 2770, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Yogi Berra', providerExternalId: 'berrayo01',
    expectedProduct: {
      name: '1975 Topps #192 Yogi Berra/Willie Mays MVP PSA 7', playerAthlete: 'Yogi Berra|Willie Mays', team: 'New York Yankees|New York Giants', year: 1975,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 25th-anniversary MVP card visibly identifies Yogi Berra as the 1954 American League MVP; the card-printing year is retrospective.',
  },
  {
    productId: 2770, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 2,
    sourcePlayerText: 'Willie Mays', providerExternalId: 'mayswi01',
    expectedProduct: {
      name: '1975 Topps #192 Yogi Berra/Willie Mays MVP PSA 7', playerAthlete: 'Yogi Berra|Willie Mays', team: 'New York Yankees|New York Giants', year: 1975,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 25th-anniversary MVP card visibly identifies Willie Mays as the 1954 National League MVP; the card-printing year is retrospective.',
  },
  {
    productId: 2774, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 1,
    sourcePlayerText: 'Elston Howard', providerExternalId: 'howarel01',
    expectedProduct: {
      name: '1975 Topps #201 Elston Howard/Sandy Koufax MVP PSA 9', playerAthlete: 'Elston Howard|Sandy Koufax', team: 'New York Yankees|Los Angeles Dodgers', year: 1975,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 25th-anniversary MVP card visibly identifies Elston Howard as the 1963 American League MVP; the card-printing year is retrospective.',
  },
  {
    productId: 2774, leagueCode: 'MLB', sourceName: 'baseball_reference', subjectOrder: 2,
    sourcePlayerText: 'Sandy Koufax', providerExternalId: 'koufasa01',
    expectedProduct: {
      name: '1975 Topps #201 Elston Howard/Sandy Koufax MVP PSA 9', playerAthlete: 'Elston Howard|Sandy Koufax', team: 'New York Yankees|Los Angeles Dodgers', year: 1975,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 25th-anniversary MVP card visibly identifies Sandy Koufax as the 1963 National League MVP; the card-printing year is retrospective.',
  },
]);

// Product-level corrections are narrower than a name alias: each one is bound
// to the exact current catalog fingerprint and can repair card-facing fields
// without replacing an otherwise source-backed athlete identity. They remain
// proposal-only; a changed player-subject list is held from mapping until the
// authoritative catalog is corrected and the coverage is regenerated.
export const REVIEWED_PRODUCT_CATALOG_CORRECTIONS = Object.freeze([
  {
    productId: 87, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1966 Topps #219 NL RBI Leaders/Deron Johnson/Frank Robinson/Willie Mays PSA 4', playerAthlete: 'Nl Rbi', team: 'National League', year: 1966,
    },
    expectedCorrectedProduct: {
      name: '1966 Topps #219 NL RBI Leaders/Deron Johnson/Frank Robinson/Willie Mays PSA 4', playerAthlete: 'Deron Johnson|Frank Robinson|Willie Mays', team: 'National League', year: 1966,
    },
    evidence: 'Local card image visibly names 1965 NL RBI leaders Deron Johnson, Frank Robinson, and Willie Mays in that order.',
    proposedCatalogCorrections: { playerAthlete: 'Deron Johnson|Frank Robinson|Willie Mays' },
  },
  {
    productId: 99, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1968 Topps #3 NL RBI Leaders/Orlando Cepeda/Roberto Clemente/Hank Aaron', playerAthlete: 'Nl Rbi', team: 'National League', year: 1968,
    },
    expectedCorrectedProduct: {
      name: '1968 Topps #3 NL RBI Leaders/Orlando Cepeda/Roberto Clemente/Hank Aaron', playerAthlete: 'Orlando Cepeda|Roberto Clemente|Hank Aaron', team: 'National League', year: 1968,
    },
    evidence: 'Local card image visibly names 1967 NL RBI leaders Orlando Cepeda, Roberto Clemente, and Hank Aaron in that order.',
    proposedCatalogCorrections: { playerAthlete: 'Orlando Cepeda|Roberto Clemente|Hank Aaron' },
  },
  {
    productId: 337, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2011 Topps Kimball Champions #KC51 Hank Aaron', playerAthlete: 'Hank Aaron', team: 'Milwaukee Brewers', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Topps Kimball Champions #KC51 Hank Aaron', playerAthlete: 'Hank Aaron', team: 'Milwaukee Braves', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Kimball Champions card visibly depicts Hank Aaron in Milwaukee Braves uniform; the stored Milwaukee Brewers field uses the wrong franchise label.',
    proposedCatalogCorrections: { team: 'Milwaukee Braves' },
  },
  {
    productId: 86, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1966 Topps #215 NL Batting Leaders/Bob Clemente/Hank Aaron/Willie Mays PSA 5', playerAthlete: 'Roberto Clemente|Hank Aaron|Willie Mays', team: 'Pittsburgh Pirates|Milwaukee Braves|San Francisco Giants', year: 1966,
    },
    expectedCorrectedProduct: {
      name: '1966 Topps #215 NL Batting Leaders/Bob Clemente/Hank Aaron/Willie Mays PSA 5', playerAthlete: 'Roberto Clemente|Hank Aaron|Willie Mays', team: 'Pittsburgh Pirates|Atlanta Braves|San Francisco Giants', year: 1966,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly labels Clemente Pittsburgh Pirates, Aaron Atlanta Braves, and Mays San Francisco Giants.',
    proposedCatalogCorrections: { team: 'Pittsburgh Pirates|Atlanta Braves|San Francisco Giants' },
  },
  {
    productId: 112, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1980 Topps #206 Strikeout Leaders/J.R. Richard/Nolan Ryan', playerAthlete: 'Nolan Ryan', team: 'Houston Astros|California Angels', year: 1980,
    },
    expectedCorrectedProduct: {
      name: '1980 Topps #206 Strikeout Leaders/J.R. Richard/Nolan Ryan', playerAthlete: 'J.R. Richard|Nolan Ryan', team: 'Houston Astros|California Angels', year: 1980,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 1980 Topps card visibly identifies the 1979 strikeout leaders in order: J.R. Richard/Houston Astros and Nolan Ryan/California Angels. The card context precedes Ryan’s 1980 Houston provider season.',
    proposedCatalogCorrections: { playerAthlete: 'J.R. Richard|Nolan Ryan' },
  },
  {
    productId: 1981, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2023 Big League Jacob Degrom Black /25 + Corey Seager Refractor + Rangers Rookie', playerAthlete: 'Corey Seager|Jacob deGrom', team: 'Texas Rangers|New York Mets', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Big League Jacob Degrom Black /25 + Corey Seager Refractor + Rangers Rookie', playerAthlete: 'Corey Seager|Jacob deGrom', team: 'Texas Rangers|Texas Rangers', year: 2023,
    },
    allowEvidenceConflict: true,
    evidence: 'Local image shows both listed players in Texas Rangers uniforms; the New York Mets field is stale.',
    proposedCatalogCorrections: { team: 'Texas Rangers|Texas Rangers' },
  },
  {
    productId: 2780, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1979 Topps #1 Batting Leaders/Rod Carew/Dave Parker', playerAthlete: 'Rod Carew|Dave Parker', team: 'Minnesota Twins|Pittsburgh Pirates', year: 1979,
    },
    expectedCorrectedProduct: {
      name: '1979 Topps #1 Batting Leaders/Rod Carew/Dave Parker', playerAthlete: 'Rod Carew|Dave Parker', team: 'California Angels|Pittsburgh Pirates', year: 1979,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly labels Rod Carew California Angels and Dave Parker Pittsburgh Pirates.',
    proposedCatalogCorrections: { team: 'California Angels|Pittsburgh Pirates' },
  },
  {
    productId: 851, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '1982 Topps Receiving Leaders Kellen Winslow + Dwight Clark #258', playerAthlete: 'Dwight Clark|Kellen Winslow', team: 'San Francisco 49ers|Tampa Bay Buccaneers', year: 1982,
    },
    expectedCorrectedProduct: {
      name: '1982 Topps Receiving Leaders Kellen Winslow + Dwight Clark #258', playerAthlete: 'Dwight Clark|Kellen Winslow', team: 'San Francisco 49ers|San Diego Chargers', year: 1982,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly labels Dwight Clark San Francisco 49ers and Kellen Winslow San Diego Chargers.',
    proposedCatalogCorrections: { team: 'San Francisco 49ers|San Diego Chargers' },
  },
  {
    productId: 979, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2012 Topps Paramount Pairs Andrew Luck & Robert Griffin III Rookie #PA-LG', playerAthlete: 'Andrew Luck|Robert Griffin III', team: 'Indianapolis Colts|Washington Commanders', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Topps Paramount Pairs Andrew Luck & Robert Griffin III Rookie #PA-LG', playerAthlete: 'Andrew Luck|Robert Griffin III', team: 'Indianapolis Colts|Washington Redskins', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows the 2012 Washington team branding for Robert Griffin III alongside Andrew Luck’s Colts branding.',
    proposedCatalogCorrections: { team: 'Indianapolis Colts|Washington Redskins' },
  },
  {
    productId: 49, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '1961 Topps #65 Ted Kluszewski', playerAthlete: 'Ted Kluszewski', team: 'Chicago White Sox', year: 1961,
    },
    expectedCorrectedProduct: {
      name: '1961 Topps #65 Ted Kluszewski', playerAthlete: 'Ted Kluszewski', team: 'Los Angeles Angels', year: 1961,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly labels Ted Kluszewski Los Angeles.',
    proposedCatalogCorrections: { team: 'Los Angeles Angels' },
  },
  {
    productId: 242, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2006 Fleer #294 Hanley Ramirez (RC)', playerAthlete: 'Hanley Ramirez', team: 'Boston Red Sox', year: 2006,
    },
    expectedCorrectedProduct: {
      name: '2006 Fleer #294 Hanley Ramirez (RC)', playerAthlete: 'Hanley Ramirez', team: 'Florida Marlins', year: 2006,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows the Florida Marlins logo, cap, and uniform.',
    proposedCatalogCorrections: { team: 'Florida Marlins' },
  },
  {
    productId: 922, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2011 Topps Allen & Ginter A.J. Burnett Framed Mini Relic Patch', playerAthlete: 'A.J. Burnett', team: 'Pittsburgh Pirates', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Topps Allen & Ginter A.J. Burnett Framed Mini Relic Patch', playerAthlete: 'A.J. Burnett', team: 'New York Yankees', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows A.J. Burnett in a Yankees cap and pinstriped uniform.',
    proposedCatalogCorrections: { team: 'New York Yankees' },
  },
  {
    productId: 1063, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2013 Topps Prince Fielder Gold Border Parallel /2013 #28', playerAthlete: 'Prince Fielder', team: 'Milwaukee Brewers', year: 2013,
    },
    expectedCorrectedProduct: {
      name: '2013 Topps Prince Fielder Gold Border Parallel /2013 #28', playerAthlete: 'Prince Fielder', team: 'Detroit Tigers', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Prince Fielder in a Detroit Tigers uniform with the Tigers D mark.',
    proposedCatalogCorrections: { team: 'Detroit Tigers' },
  },
  {
    productId: 606, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2012 Panini Black Friday Thanksgiving #4 Robert Griffin III', playerAthlete: 'Robert Griffin III', team: 'Washington Commanders', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Panini Black Friday Thanksgiving #4 Robert Griffin III', playerAthlete: 'Robert Griffin III', team: 'Washington Redskins', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows the historic 2012 Washington uniform and logo.',
    proposedCatalogCorrections: { team: 'Washington Redskins' },
  },
  {
    productId: 607, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2012 Panini Black Friday Black Holofoil #6 Robert Griffin III', playerAthlete: 'Robert Griffin III', team: 'Washington Commanders', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Panini Black Friday Black Holofoil #6 Robert Griffin III', playerAthlete: 'Robert Griffin III', team: 'Washington Redskins', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Robert Griffin III in the historic 2012 Washington uniform.',
    proposedCatalogCorrections: { team: 'Washington Redskins' },
  },
  {
    productId: 871, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2005 Fleer Ultra Edgerrin James All Ultra Team SSP Game Worn Patch /50 Colts', playerAthlete: 'Edgerrin James', team: 'Arizona Cardinals', year: 2005,
    },
    expectedCorrectedProduct: {
      name: '2005 Fleer Ultra Edgerrin James All Ultra Team SSP Game Worn Patch /50 Colts', playerAthlete: 'Edgerrin James', team: 'Indianapolis Colts', year: 2005,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card front and reverse identify Edgerrin James with the Indianapolis Colts.',
    proposedCatalogCorrections: { team: 'Indianapolis Colts' },
  },
  {
    productId: 941, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2012 Donruss Elite Alfred Morris Rookie Hard Hats /399 + Refractor /999 + SP RC', playerAthlete: 'Alfred Morris', team: 'Washington Commanders', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Donruss Elite Alfred Morris Rookie Hard Hats /399 + Refractor /999 + SP RC', playerAthlete: 'Alfred Morris', team: 'Washington Redskins', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image explicitly uses the historic 2012 Washington team name.',
    proposedCatalogCorrections: { team: 'Washington Redskins' },
  },
  {
    productId: 1105, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2015 Panini Certified Melvin Gordon III New Generation Rookie Patch Refractor #5', playerAthlete: 'Melvin Gordon', team: 'Los Angeles Chargers', year: 2015,
    },
    expectedCorrectedProduct: {
      name: '2015 Panini Certified Melvin Gordon III New Generation Rookie Patch Refractor #5', playerAthlete: 'Melvin Gordon', team: 'San Diego Chargers', year: 2015,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card reverse explicitly references the 2015 San Diego Chargers organization.',
    proposedCatalogCorrections: { team: 'San Diego Chargers' },
  },
  {
    productId: 2968, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2011 Topps Rising Rookies #114 Prince Amukamara RC', playerAthlete: 'Prince Amukamara', team: 'New York Giants FB', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Topps Rising Rookies #114 Prince Amukamara RC', playerAthlete: 'Prince Amukamara', team: 'New York Giants', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card states that Prince Amukamara was selected by the Giants; the stored FB suffix is extraneous.',
    proposedCatalogCorrections: { team: 'New York Giants' },
  },
  {
    productId: 983, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2012 Topps Update Series Dan Straily Gold Foil Rookie /2012 #128', playerAthlete: 'Series Dan', team: '', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Topps Update Series Dan Straily Gold Foil Rookie /2012 #128', playerAthlete: 'Dan Straily', team: 'Oakland Athletics', year: 2012,
    },
    evidence: 'Local card image visibly identifies Dan Straily and Oakland Athletics; the stored player text is an import fragment and team is blank.',
    proposedCatalogCorrections: { playerAthlete: 'Dan Straily', team: 'Oakland Athletics' },
  },
  {
    productId: 2015, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2023 Topps Update Series Estevan Florial Purple Foil /799 #US211', playerAthlete: 'Series Estevan', team: '', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Topps Update Series Estevan Florial Purple Foil /799 #US211', playerAthlete: 'Estevan Florial', team: 'New York Yankees', year: 2023,
    },
    evidence: 'Local card image visibly identifies Estevan Florial and New York Yankees; the stored player text is an import fragment and team is blank.',
    proposedCatalogCorrections: { playerAthlete: 'Estevan Florial', team: 'New York Yankees' },
  },
  {
    productId: 2918, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2013 Topps Heritage New Age Performers #MT Mike Trout', playerAthlete: 'Heritage New Age Performers -MT Mike Trout', team: 'Los Angeles Angels', year: 2013,
    },
    expectedCorrectedProduct: {
      name: '2013 Topps Heritage New Age Performers #MT Mike Trout', playerAthlete: 'Mike Trout', team: 'Los Angeles Angels', year: 2013,
    },
    evidence: 'Local card image visibly identifies Mike Trout, Angels outfielder; the stored player field contains the insert-set label.',
    proposedCatalogCorrections: { playerAthlete: 'Mike Trout' },
  },
  {
    productId: 571, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2011 Upper Deck Saturday in Action #SIA1 Troy Aikman', playerAthlete: 'Troy Aikman', team: 'Dallas Cowboys', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Upper Deck Saturday in Action #SIA1 Troy Aikman', playerAthlete: 'Troy Aikman', team: 'UCLA Bruins', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Troy Aikman in UCLA Bruins uniform; the stored Dallas Cowboys field describes his pro career, not this card.',
    proposedCatalogCorrections: { team: 'UCLA Bruins' },
  },
  {
    productId: 965, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2012 Press Pass Mark Barron On-Card Rookie Auto', playerAthlete: 'Mark Barron', team: 'Los Angeles Rams', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Press Pass Mark Barron On-Card Rookie Auto', playerAthlete: 'Mark Barron', team: 'Alabama Crimson Tide', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Mark Barron in Alabama Crimson Tide uniform; the stored Los Angeles Rams field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Alabama Crimson Tide' },
  },
  {
    productId: 1051, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2013 Press Pass Alec Ogletree Rookie Auto #PPS-AO', playerAthlete: 'Alec Ogletree', team: 'Los Angeles Rams', year: 2013,
    },
    expectedCorrectedProduct: {
      name: '2013 Press Pass Alec Ogletree Rookie Auto #PPS-AO', playerAthlete: 'Alec Ogletree', team: 'Georgia Bulldogs', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Alec Ogletree in Georgia Bulldogs uniform; the stored Los Angeles Rams field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Georgia Bulldogs' },
  },
  {
    productId: 1104, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2015 Leaf Ultimate Draft Melvin Gordon Helmet Die-Cut Auto /40', playerAthlete: 'Melvin Gordon', team: 'Los Angeles Chargers', year: 2015,
    },
    expectedCorrectedProduct: {
      name: '2015 Leaf Ultimate Draft Melvin Gordon Helmet Die-Cut Auto /40', playerAthlete: 'Melvin Gordon', team: 'Wisconsin Badgers', year: 2015,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly shows Melvin Gordon with Wisconsin Badgers helmet and uniform; the stored Los Angeles Chargers field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Wisconsin Badgers' },
  },
  {
    productId: 1121, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2016 Sage Hit Jared Goff All Rookie Team + Next Level Rookie Set (x2)', playerAthlete: 'Jared Goff', team: 'Detroit Lions', year: 2016,
    },
    expectedCorrectedProduct: {
      name: '2016 Sage Hit Jared Goff All Rookie Team + Next Level Rookie Set (x2)', playerAthlete: 'Jared Goff', team: 'California Golden Bears', year: 2016,
    },
    allowEvidenceConflict: true,
    evidence: 'Both local card images visibly identify Jared Goff as a California Golden Bear; the stored Detroit Lions field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'California Golden Bears' },
  },
  {
    productId: 1985, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2023 Panini Clear Vision Aaron Rodgers + Donruss Clearly Joe Namath Jets Set (2)', playerAthlete: 'Aaron Rodgers', team: 'Green Bay Packers', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Panini Clear Vision Aaron Rodgers + Donruss Clearly Joe Namath Jets Set (2)', playerAthlete: 'Aaron Rodgers|Joe Namath', team: 'California Golden Bears|Alabama Crimson Tide', year: 2023,
    },
    allowEvidenceConflict: true,
    evidence: 'Local set photo visibly contains an Aaron Rodgers California Golden Bears card and a Joe Namath Crimson Tide card; the stored single-player Packers record is incomplete and inaccurate.',
    proposedCatalogCorrections: { playerAthlete: 'Aaron Rodgers|Joe Namath', team: 'California Golden Bears|Alabama Crimson Tide' },
  },
  {
    productId: 1997, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2023 Sportkings Volume No. 4 Darrell Green Game Worn Relic Patch #LSM-68', playerAthlete: 'Darrell Green', team: 'Washington Commanders', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Sportkings Volume No. 4 Darrell Green Game Worn Relic Patch #LSM-68', playerAthlete: 'Darrell Green', team: 'Washington Redskins', year: 2023,
    },
    allowEvidenceConflict: true,
    evidence: 'Local relic card image visibly shows Darrell Green’s historic Washington Redskins number 28 jersey; the current Commanders label is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Washington Redskins' },
  },
  {
    productId: 1998, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2023 Sportkings Volume No. 4 Rich Gannon Game Worn Relic Patch #LSM-70', playerAthlete: 'Rich Gannon', team: 'Las Vegas Raiders', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Sportkings Volume No. 4 Rich Gannon Game Worn Relic Patch #LSM-70', playerAthlete: 'Rich Gannon', team: 'Kansas City Chiefs', year: 2023,
    },
    allowEvidenceConflict: true,
    evidence: 'Local relic card image visibly shows Rich Gannon’s Kansas City Chiefs number 12 jersey; the stored Las Vegas Raiders label is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Kansas City Chiefs' },
  },
  {
    productId: 2972, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2011 Upper Deck #14 John Elway', playerAthlete: 'John Elway', team: 'Denver Broncos', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Upper Deck #14 John Elway', playerAthlete: 'John Elway', team: 'Stanford Cardinal', year: 2011,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly identifies John Elway in Stanford Cardinal uniform; the stored Denver Broncos field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Stanford Cardinal' },
  },
  {
    productId: 2032, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2023 Topps Update Series Vladimir Guerrero Major League Material Patch', playerAthlete: 'Vladimir Guerrero', team: 'Montreal Expos', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Topps Update Series Vladimir Guerrero Major League Material Patch', playerAthlete: 'Vladimir Guerrero Jr.', team: 'Toronto Blue Jays', year: 2023,
    },
    evidence: 'Local Major League Material card visibly identifies Vladimir Guerrero Jr. and Toronto Blue Jays; the current father/Expos fields are incorrect.',
    proposedCatalogCorrections: { playerAthlete: 'Vladimir Guerrero Jr.', team: 'Toronto Blue Jays' },
  },
  {
    productId: 249, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2006 BBM Japan #582 Yu Darvish', playerAthlete: 'Yu Darvish', team: 'Texas Rangers', year: 2006,
    },
    expectedCorrectedProduct: {
      name: '2006 BBM Japan #582 Yu Darvish', playerAthlete: 'Yu Darvish', team: 'Hokkaido Nippon-Ham Fighters', year: 2006,
    },
    allowEvidenceConflict: true,
    evidence: 'Local 2006 BBM Japan card visibly identifies Yu Darvish with Fighters branding; the 2006 BBM #582 checklist identifies the Hokkaido Nippon-Ham Fighters context, not the later Texas Rangers.',
    proposedCatalogCorrections: { team: 'Hokkaido Nippon-Ham Fighters' },
  },
  {
    productId: 329, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2011 Bowman Chrome Draft Prospects #BDPP12 Dante Bichette', playerAthlete: 'Dante Bichette', team: 'New York Yankees', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Bowman Chrome Draft Prospects #BDPP12 Dante Bichette', playerAthlete: 'Dante Bichette Jr.', team: 'New York Yankees', year: 2011,
    },
    evidence: 'Local 2011 Yankees prospect card identifies Dante Bichette Jr.; the current unqualified name points to his retired father in the local provider cache.',
    proposedCatalogCorrections: { playerAthlete: 'Dante Bichette Jr.' },
  },
  {
    productId: 330, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2011 Bowman Sterling Prospects #31 Dante Bichette', playerAthlete: 'Dante Bichette', team: 'New York Yankees', year: 2011,
    },
    expectedCorrectedProduct: {
      name: '2011 Bowman Sterling Prospects #31 Dante Bichette', playerAthlete: 'Dante Bichette Jr.', team: 'New York Yankees', year: 2011,
    },
    evidence: 'Local 2011 Yankees prospect card identifies Dante Bichette Jr.; the current unqualified name points to his retired father in the local provider cache.',
    proposedCatalogCorrections: { playerAthlete: 'Dante Bichette Jr.' },
  },
  {
    productId: 896, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2010 Bowman Chrome Brett Jackson Rookie Refractor Auto Set /500 + Base (x3)', playerAthlete: 'Brett Jackson', team: '', year: 2010,
    },
    expectedCorrectedProduct: {
      name: '2010 Bowman Chrome Brett Jackson Rookie Refractor Auto Set /500 + Base (x3)', playerAthlete: 'Brett Jackson', team: 'Chicago Cubs', year: 2010,
    },
    allowEvidenceConflict: true,
    evidence: 'All three local Brett Jackson cards visibly carry Chicago Cubs branding; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Chicago Cubs' },
  },
  {
    productId: 942, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2012 Donruss Elite Corey Seager Yearbook Rookie + 2021 Topps Gold Label (x3)', playerAthlete: 'Corey Seager', team: 'Texas Rangers', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Donruss Elite Corey Seager Yearbook Rookie + 2021 Topps Gold Label (x3)', playerAthlete: 'Corey Seager', team: 'Los Angeles Dodgers', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'All three local Corey Seager cards visibly carry Los Angeles Dodgers branding; the stored Texas Rangers field is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Los Angeles Dodgers' },
  },
  {
    productId: 943, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2012 Donruss Elite Extra Edition Chris Stratton Status Rookie Die-Cut /200', playerAthlete: 'Chris Stratton', team: 'Pittsburgh Pirates', year: 2012,
    },
    expectedCorrectedProduct: {
      name: '2012 Donruss Elite Extra Edition Chris Stratton Status Rookie Die-Cut /200', playerAthlete: 'Chris Stratton', team: 'San Francisco Giants', year: 2012,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Chris Stratton card visibly identifies San Francisco; the stored Pittsburgh Pirates field reflects a later career stop rather than the card.',
    proposedCatalogCorrections: { team: 'San Francisco Giants' },
  },
  {
    productId: 1012, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2013 Bowman Chrome Nik Turley Mini Refractor Rookie /125 #116', playerAthlete: 'Nik Turley', team: '', year: 2013,
    },
    expectedCorrectedProduct: {
      name: '2013 Bowman Chrome Nik Turley Mini Refractor Rookie /125 #116', playerAthlete: 'Nik Turley', team: 'New York Yankees', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Bowman Chrome card visibly identifies Nik Turley with New York Yankees branding; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'New York Yankees' },
  },
  {
    productId: 1029, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2013 Donruss Elite Extra Edition Aaron Slegers Aspirations Rookie Die-Cut /200', playerAthlete: 'Aaron Slegers', team: '', year: 2013,
    },
    expectedCorrectedProduct: {
      name: '2013 Donruss Elite Extra Edition Aaron Slegers Aspirations Rookie Die-Cut /200', playerAthlete: 'Aaron Slegers', team: 'Minnesota Twins', year: 2013,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Elite Extra Edition card visibly identifies Aaron Slegers with Minnesota branding; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Minnesota Twins' },
  },
  {
    productId: 1111, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2016 Bowman Chrome Kevin Kramer Prospect Auto Rookie Set (x2) #CPA-KK', playerAthlete: 'Kevin Kramer', team: '', year: 2016,
    },
    expectedCorrectedProduct: {
      name: '2016 Bowman Chrome Kevin Kramer Prospect Auto Rookie Set (x2) #CPA-KK', playerAthlete: 'Kevin Kramer', team: 'Pittsburgh Pirates', year: 2016,
    },
    allowEvidenceConflict: true,
    evidence: 'Both local Kevin Kramer prospect cards visibly carry Pittsburgh Pirates branding; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Pittsburgh Pirates' },
  },
  {
    productId: 1982, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2023 Bowman Chrome Luis Rodriguez Mojo Refractor + Herrera & Burleson Rookie Set', playerAthlete: 'Luis Rodriguez', team: '', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Bowman Chrome Luis Rodriguez Mojo Refractor + Herrera & Burleson Rookie Set', playerAthlete: 'Luis Rodriguez|Ivan Herrera|Alec Burleson', team: '', year: 2023,
    },
    holdMappingAfterCorrection: true,
    evidence: 'Local set image visibly contains cards for Luis Rodriguez, Ivan Herrera, and Alec Burleson; the cache only has an unrelated older Luis Rodriguez, so no provider mapping may be inferred after this catalog repair.',
    proposedCatalogCorrections: { playerAthlete: 'Luis Rodriguez|Ivan Herrera|Alec Burleson' },
  },
  {
    productId: 3224, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2024 Topps Transcendent Icons Hank Aaron Orange /25 #06', playerAthlete: 'Hank Aaron', team: '', year: 2024,
    },
    expectedCorrectedProduct: {
      name: '2024 Topps Transcendent Icons Hank Aaron Orange /25 #06', playerAthlete: 'Hank Aaron', team: 'Milwaukee Braves', year: 2024,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Transcendent Icons card visibly shows Hank Aaron in a Milwaukee Braves cap and uniform; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Milwaukee Braves' },
  },
  {
    productId: 3529, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2023 Topps Nolan Ryan All Aces SSP Auto /25 PSA 8', playerAthlete: 'Nolan Ryan', team: '', year: 2023,
    },
    expectedCorrectedProduct: {
      name: '2023 Topps Nolan Ryan All Aces SSP Auto /25 PSA 8', playerAthlete: 'Nolan Ryan', team: 'Houston Astros', year: 2023,
    },
    allowEvidenceConflict: true,
    evidence: 'Local graded All Aces autograph visibly identifies Nolan Ryan and Houston Astros; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Houston Astros' },
  },
  {
    productId: 3620, leagueCode: 'MLB', sourceName: 'baseball_reference',
    expectedProduct: {
      name: '2024 Topps Transcendent Icons Hank Aaron Orange Refractor /25 #86', playerAthlete: 'Hank Aaron', team: 'Atlanta Braves', year: 2024,
    },
    expectedCorrectedProduct: {
      name: '2024 Topps Transcendent Icons Hank Aaron Orange Refractor /25 #86', playerAthlete: 'Hank Aaron', team: 'Milwaukee Braves', year: 2024,
    },
    allowEvidenceConflict: true,
    evidence: 'Local Transcendent Icons card visibly shows Hank Aaron in a Milwaukee Braves cap and uniform; the stored Atlanta label is not card-facing metadata.',
    proposedCatalogCorrections: { team: 'Milwaukee Braves' },
  },
  {
    productId: 3272, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    expectedProduct: {
      name: '2025 Panini Select Brian Urlacher Premier Level Orange Prizm /399', playerAthlete: 'Brian Urlacher', team: '', year: 2025,
    },
    expectedCorrectedProduct: {
      name: '2025 Panini Select Brian Urlacher Premier Level Orange Prizm /399', playerAthlete: 'Brian Urlacher', team: 'Chicago Bears', year: 2025,
    },
    allowEvidenceConflict: true,
    evidence: 'Local card image visibly labels Brian Urlacher Bears and shows Chicago Bears uniform; the catalog team field is blank.',
    proposedCatalogCorrections: { team: 'Chicago Bears' },
  },
]);

// These records are visibly not NFL player cards even though their current
// catalog category/league says Football/NFL. Leaving them in the mapping queue
// would create false identity pressure. They remain catalog-data correction
// candidates, never silently changed by this mapping workflow.
export const REVIEWED_PRODUCT_IDENTITY_EXCLUSIONS = Object.freeze([
  {
    productId: 8, leagueCode: 'MLB', sourceName: 'baseball_reference',
    disposition: 'catalog_subject_conflict_review',
    expectedProduct: {
      name: '1956 Topps #31 Hank Aaron UER DP/Small photo/actually Willie Mays PSA 6', playerAthlete: 'Hank Aaron', team: 'Milwaukee Braves', year: 1956,
    },
    evidence: 'Card title says the Hank Aaron error card actually depicts Willie Mays; do not map the conflicting catalog player text automatically.',
  },
  {
    productId: 1182, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    disposition: 'intentionally_unmapped_catalog_misclassification',
    expectedProduct: {
      name: '2020-21 Panini Contenders Kerry Blackshear Prospect Ticket Rookie Auto #24', playerAthlete: 'Kerry Blackshear', team: '', year: 2020,
    },
    evidence: 'Local card photo identifies a Panini Contenders Draft Picks basketball card for Kerry Blackshear Jr.',
    proposedCatalogCorrections: { category: 'Basketball', sport: 'Basketball', league: 'NBA or NCAA review required' },
  },
  {
    productId: 1996, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    disposition: 'intentionally_unmapped_catalog_misclassification',
    expectedProduct: {
      name: '2023 SportKings Vol No. 4 Ricky Rudd Race Worn Relic Card #LSM-58', playerAthlete: 'Ricky Rudd', team: 'Collectibles', year: 2023,
    },
    evidence: 'Local card photo identifies a SportKings racing relic for Ricky Rudd, not an NFL player card.',
    proposedCatalogCorrections: { category: 'Collectibles', sport: 'Motorsports', league: 'NASCAR review required' },
  },
  {
    productId: 2179, leagueCode: 'NFL', sourceName: 'pro_football_reference',
    disposition: 'intentionally_unmapped_catalog_misclassification',
    expectedProduct: {
      name: '2023-24 Panini Contenders Charles Bediako Game Day Ticket Rookie Auto #155', playerAthlete: 'Charles Bediako', team: '', year: 2023,
    },
    evidence: 'Local card photo identifies a 2023-24 Panini Contenders basketball card for Charles Bediako.',
    proposedCatalogCorrections: { category: 'Basketball', sport: 'Basketball', league: 'NBA or NCAA review required' },
  },
]);

// Pro Football Reference season tables often expose a team abbreviation rather
// than a readable franchise name. This decoder is only used to test an exact
// catalog-team match during same-name disambiguation; it does not infer a team.
// A code can use `{ name, firstSeason, lastSeason }` when its display name
// changed over time. That keeps a historic card from matching a modern brand.
export const NFL_TEAM_CODE_NAMES = Object.freeze({
  ARI: [{ name: 'Arizona Cardinals', firstSeason: 1994 }], ATL: ['Atlanta Falcons'],
  BAL: [{ name: 'Baltimore Ravens', firstSeason: 1996 }],
  BUF: ['Buffalo Bills'], CAR: ['Carolina Panthers'], CHI: ['Chicago Bears'],
  CIN: ['Cincinnati Bengals'], CLE: ['Cleveland Browns'],
  CLT: [{ name: 'Baltimore Colts', lastSeason: 1983 }, { name: 'Indianapolis Colts', firstSeason: 1984 }],
  CRD: [
    { name: 'St. Louis Cardinals', lastSeason: 1987 },
    { name: 'Phoenix Cardinals', firstSeason: 1988, lastSeason: 1993 },
    { name: 'Arizona Cardinals', firstSeason: 1994 },
  ],
  DAL: ['Dallas Cowboys'], DEN: ['Denver Broncos'], DET: ['Detroit Lions'],
  GNB: ['Green Bay Packers'], HOU: [{ name: 'Houston Texans', firstSeason: 2002 }], HTX: [{ name: 'Houston Texans', firstSeason: 2002 }],
  IND: [{ name: 'Indianapolis Colts', firstSeason: 1984 }], JAX: ['Jacksonville Jaguars'], KAN: ['Kansas City Chiefs'],
  LAC: [{ name: 'Los Angeles Chargers', firstSeason: 2017 }], LAR: [{ name: 'Los Angeles Rams', firstSeason: 2016 }], LVR: [{ name: 'Las Vegas Raiders', firstSeason: 2020 }],
  MIA: ['Miami Dolphins'], MIN: ['Minnesota Vikings'], NWE: ['New England Patriots'],
  NOR: ['New Orleans Saints'], NYG: ['New York Giants'], NYJ: ['New York Jets'],
  OAK: [{ name: 'Oakland Raiders', lastSeason: 1981 }, { name: 'Oakland Raiders', firstSeason: 1995, lastSeason: 2019 }],
  OTI: [
    { name: 'Houston Oilers', lastSeason: 1996 },
    { name: 'Tennessee Oilers', firstSeason: 1997, lastSeason: 1998 },
    { name: 'Tennessee Titans', firstSeason: 1999 },
  ],
  PHI: ['Philadelphia Eagles'], PIT: ['Pittsburgh Steelers'], RAI: [
    { name: 'Oakland Raiders', lastSeason: 1981 },
    { name: 'Los Angeles Raiders', firstSeason: 1982, lastSeason: 1994 },
    { name: 'Oakland Raiders', firstSeason: 1995, lastSeason: 2019 },
    { name: 'Las Vegas Raiders', firstSeason: 2020 },
  ],
  RAM: [
    { name: 'Los Angeles Rams', lastSeason: 1994 },
    { name: 'St. Louis Rams', firstSeason: 1995, lastSeason: 2015 },
    { name: 'Los Angeles Rams', firstSeason: 2016 },
  ],
  RAV: [{ name: 'Baltimore Ravens', firstSeason: 1996 }], SEA: ['Seattle Seahawks'],
  SFO: ['San Francisco 49ers'], SDG: [
    { name: 'San Diego Chargers', lastSeason: 2016 },
    { name: 'Los Angeles Chargers', firstSeason: 2017 },
  ],
  STL: [{ name: 'St. Louis Rams', firstSeason: 1995, lastSeason: 2015 }],
  TAM: ['Tampa Bay Buccaneers'], TEN: ['Tennessee Titans'],
  WAS: [
    { name: 'Washington Redskins', lastSeason: 2019 },
    { name: 'Washington Football Team', firstSeason: 2020, lastSeason: 2021 },
    { name: 'Washington Commanders', firstSeason: 2022 },
  ],
});

// These values identify reviewed college-card contexts. They permit a verified
// NFL player identity without pretending a college uniform is a conflicting
// professional team record. The list stays deliberately narrow and image-led.
export const NFL_CARD_CONTEXT_TEAMS = Object.freeze([
  'Alabama Crimson Tide',
  'California Golden Bears',
  'Georgia Bulldogs',
  'Stanford Cardinal',
  'UCLA Bruins',
  'Wisconsin Badgers',
]);

// These values describe the card's event, league, or national-team context,
// rather than a player's club team. They are intentionally limited to the
// reviewed forms below; they never infer an individual player's team.
export const MLB_CARD_CONTEXT_TEAMS = Object.freeze([
  'National League',
  'American League',
  'Team USA',
  'Team Japan',
]);

// Same-franchise spelling variation in the catalog/provider data. This does
// not bridge different historical cities or franchises.
export const MLB_TEAM_NAME_ALIASES = Object.freeze({
  'los angeles angels': 'los angeles angels of anaheim',
});
