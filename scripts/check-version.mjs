import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
for (const path of ['../packages/client/package.json', '../packages/extension/package.json']) {
  if (JSON.parse(readFileSync(new URL(path, import.meta.url))).version !== version) throw new Error(`Version mismatch: ${path}`);
}
const python = readFileSync(new URL('../pyproject.toml', import.meta.url), 'utf8').match(/^version = "([^"]+)"/m)?.[1];
if (python !== version) throw new Error('Python and npm versions must match');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) throw new Error('Release tag must match package versions');
console.log(version);
