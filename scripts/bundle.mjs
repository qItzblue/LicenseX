// Builds dist/licensex-deploy.zip: the folder you upload to a host. Everything needed to run, nothing else.
//   npm run bundle
import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectFiles } from '../server/jarstamp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FOLDER = 'LicenseX';
const INCLUDE_DIRS = ['server', 'web', 'docs'];
const INCLUDE_FILES = ['package.json', 'README.md', 'DEPLOY.md', 'DESIGN_BRIEF.md', 'LICENSE', 'licensex.config.example.json', 'start.sh', 'start.bat', 'Dockerfile', '.dockerignore'];

const walk = dir => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const paths = [...INCLUDE_DIRS.flatMap(d => walk(join(ROOT, d))), ...INCLUDE_FILES.map(f => join(ROOT, f))];
const files = paths.map(p => ({ name: `${FOLDER}/${relative(ROOT, p).split(sep).join('/')}`, content: readFileSync(p) }));
files.push({ name: `${FOLDER}/data/README.txt`, content: 'LicenseX stores your licenses here. Keep this folder (or use Settings -> Backup in the admin).\n' });

const EMPTY = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);
const zip = injectFiles(EMPTY, files);
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const out = join(ROOT, 'dist', 'licensex-deploy.zip');
writeFileSync(out, zip);
console.log(`${files.length} files, ${(zip.length / 1024).toFixed(0)} KB -> ${relative(process.cwd(), out)}`);
