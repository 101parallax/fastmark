// fastmark entrypoint, written for the make.fun markdown-render-speed-02
// bounty: render every case in /input/cases.json with parse() from parse.js
// and write the HTML strings, in order, to /output/html.json.
// Run by the harness as `node /bot/main.ts` on Node 22 (type stripping,
// erasable syntax only). Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
