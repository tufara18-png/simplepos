// `www/` files are symlinks into the repo root (single source of truth for
// local dev). `npx cap copy android` preserves symlinks verbatim instead of
// dereferencing them, so once copied one directory deeper into
// android/app/src/main/assets/public/, the relative target (`../x`) no
// longer resolves and every asset becomes a broken symlink. Replace each
// broken symlink with the real file it was supposed to point to.
import { readdirSync, lstatSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDir = join(repoRoot, 'android/app/src/main/assets/public');

if (!existsSync(assetsDir)) {
  console.log('No android assets dir found, skipping (did you run `npx cap copy android` first?)');
  process.exit(0);
}

let fixed = 0;
for (const name of readdirSync(assetsDir)) {
  const path = join(assetsDir, name);
  if (!lstatSync(path).isSymbolicLink()) continue;
  const source = join(repoRoot, basename(name));
  if (!existsSync(source)) {
    console.warn(`Skipping ${name}: no matching file at repo root (${source})`);
    continue;
  }
  unlinkSync(path);
  writeFileSync(path, readFileSync(source));
  fixed++;
}
console.log(`Fixed ${fixed} broken symlink(s) in android/app/src/main/assets/public`);
