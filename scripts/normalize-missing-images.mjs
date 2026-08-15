import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const execFileAsync = promisify(execFile);
const FILES = [
  'products.json',
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-comics.json',
  'products-collectibles.json',
  'products-sports.json',
  'products-featured.json'
];

const FALLBACKS = {
  Baseball: 'assets/placeholder-baseball.svg',
  Basketball: 'assets/placeholder-basketball.svg',
  Football: 'assets/placeholder-football.svg',
  Comics: 'assets/placeholder-comics.svg',
  Collectibles: 'assets/clubhouse-sign.png',
  Other: 'assets/clubhouse-sign.png'
};
const WINDOWS_1252_BYTES = new Map([
  [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
  [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93],
  [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
  [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F]
]);

function isRemoteOrEmbeddedAsset(value = '') {
  return /^(?:https?:|data:|blob:)/i.test(String(value || '').trim());
}

function repairUtf8Mojibake(value = '') {
  const original = String(value || '');
  if (!/[ÃÂâ]/.test(original)) return original;

  try {
    const bytes = [];
    for (const character of original) {
      const codePoint = character.codePointAt(0);
      const byte = codePoint <= 0xFF ? codePoint : WINDOWS_1252_BYTES.get(codePoint);
      if (byte == null) return original;
      bytes.push(byte);
    }
    const repaired = Buffer.from(bytes).toString('utf8');
    return repaired.includes('\uFFFD') ? original : repaired;
  } catch {
    return original;
  }
}

async function exists(relPath) {
  if (isRemoteOrEmbeddedAsset(relPath)) return true;
  const localPath = String(relPath || '').split('?')[0];
  if (!localPath) return false;

  try {
    await fs.access(path.join(root, localPath));
    return true;
  } catch {
    return false;
  }
}

async function normalizeAssetPath(assetPath) {
  if (!assetPath || isRemoteOrEmbeddedAsset(assetPath)) return assetPath;
  if (await exists(assetPath)) return assetPath;

  const repairedPath = repairUtf8Mojibake(assetPath);
  if (repairedPath !== assetPath && await exists(repairedPath)) {
    return repairedPath;
  }

  return '';
}

let totalChanges = 0;
for (const file of FILES) {
  const fullPath = path.join(root, file);
  const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  let fileChanges = 0;

  for (const item of raw) {
    const fallback = FALLBACKS[item.category] || FALLBACKS.Other;
    const nextImage = await normalizeAssetPath(item.image) || fallback;
    if (nextImage !== item.image) fileChanges += 1;
    item.image = nextImage;

    if (Array.isArray(item.imageGallery)) {
      const previousGallery = JSON.stringify(item.imageGallery);
      const validGallery = [];
      for (const imagePath of item.imageGallery) {
        const normalizedPath = await normalizeAssetPath(imagePath);
        if (normalizedPath) validGallery.push(normalizedPath);
      }
      if (!validGallery.length && item.image && await exists(item.image)) {
        validGallery.push(item.image);
      }
      item.imageGallery = validGallery;
      if (JSON.stringify(validGallery) !== previousGallery) fileChanges += 1;
    }
  }

  if (applyChanges && file === 'products.json' && fileChanges) {
    await fs.writeFile(fullPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  }
  totalChanges += fileChanges;
  console.log(`${file}: ${fileChanges} image reference(s) ${applyChanges ? 'normalized' : 'would change'}`);
}

if (applyChanges) {
  await execFileAsync(
    process.execPath,
    [path.join(root, 'scripts', 'build-public-catalog.mjs'), '--optimize-segments'],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 }
  );
}

console.log(`${applyChanges ? 'Normalized' : 'Audited'} ${totalChanges} image reference(s) across ${FILES.length} catalog files.`);
