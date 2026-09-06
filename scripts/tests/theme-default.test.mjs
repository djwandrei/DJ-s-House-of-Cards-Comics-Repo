import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const htmlEntries = [
  ...readdirSync(root).filter((name) => name.endsWith('.html')),
  ...readdirSync(path.join(root, 'tools'), { recursive: true })
    .filter((name) => String(name).endsWith('.html'))
    .map((name) => path.posix.join('tools', String(name).replaceAll('\\', '/'))),
];

test('every shared storefront entry defaults dark before page content and honors light storage', () => {
  assert.ok(htmlEntries.length >= 20);
  for (const entry of htmlEntries) {
    const html = readFileSync(path.join(root, entry), 'utf8');
    assert.match(
      html,
      /<body\b(?=[^>]*\bclass=(['\"])[^'\"]*\bdark-mode\b[^'\"]*\1)[^>]*>\s*<script\s+src=(['\"])(?:\.\.\/)*theme-init\.js\?v=20260905u\2>/i,
      entry + ' must bootstrap the dark default before visible content',
    );
  }
  const bootstrap = readFileSync(path.join(root, 'theme-init.js'), 'utf8');
  assert.match(bootstrap, /localStorage\.getItem\('theme'\) === 'light'/);
  assert.match(bootstrap, /classList\.toggle\('dark-mode', theme === 'dark'\)/);
});

test('the existing theme control preserves an explicit choice and PWA opens dark', () => {
  const core = readFileSync(path.join(root, 'core.js'), 'utf8');
  assert.match(core, /const isDarkMode = theme !== 'light'/);
  assert.match(core, /const nextTheme = document\.body\.classList\.contains\('dark-mode'\) \? 'light' : 'dark'/);
  assert.match(core, /safeStorageSet\(STORAGE_KEYS\.theme, nextTheme\)/);
  const manifest = JSON.parse(readFileSync(path.join(root, 'site.webmanifest'), 'utf8'));
  assert.equal(manifest.background_color, '#08122f');
});
