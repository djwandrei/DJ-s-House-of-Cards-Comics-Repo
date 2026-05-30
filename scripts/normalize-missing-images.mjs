import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
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

async function exists(relPath) {
  try {
    await fs.access(path.join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

for (const file of FILES) {
  const fullPath = path.join(root, file);
  const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));

  for (const item of raw) {
    const fallback = FALLBACKS[item.category] || FALLBACKS.Other;
    if (!item.image || !(await exists(item.image))) {
      item.image = fallback;
    }

    if (Array.isArray(item.imageGallery)) {
      const validGallery = [];
      for (const imagePath of item.imageGallery) {
        if (await exists(imagePath)) validGallery.push(imagePath);
      }
      item.imageGallery = validGallery;
    }
  }

  await fs.writeFile(fullPath, JSON.stringify(raw), 'utf8');
  console.log(`Normalized images in ${file}`);
}
