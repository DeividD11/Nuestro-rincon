#!/usr/bin/env node
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coverageDir = resolve(root, 'coverage');
const reportPath = resolve(coverageDir, 'lcov.info');
const thresholds = {
  lines: Number(process.env.NR_COVERAGE_LINES || 25),
  functions: Number(process.env.NR_COVERAGE_FUNCTIONS || 35),
  branches: Number(process.env.NR_COVERAGE_BRANCHES || 55)
};

for (const [name, value] of Object.entries(thresholds)) {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`Umbral de cobertura inválido: ${name}=${value}`);
  }
}

await mkdir(coverageDir, { recursive: true });
await rm(reportPath, { force: true });

const testFiles = (await readdir(resolve(root, 'tests'), { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => `tests/${entry.name}`)
  .sort();
if (testFiles.length === 0) throw new Error('No se encontraron archivos tests/*.test.mjs.');

const args = [
  '--experimental-test-coverage',
  '--test',
  '--test-coverage-include=assets/js/**/*.js',
  `--test-coverage-lines=${thresholds.lines}`,
  `--test-coverage-functions=${thresholds.functions}`,
  `--test-coverage-branches=${thresholds.branches}`,
  '--test-reporter=spec',
  '--test-reporter-destination=stdout',
  '--test-reporter=lcov',
  `--test-reporter-destination=${reportPath}`,
  ...testFiles
];

const result = spawnSync(process.execPath, args, {
  cwd: root,
  encoding: 'utf8',
  stdio: 'inherit',
  env: process.env,
  maxBuffer: 16 * 1024 * 1024
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const info = await readFile(reportPath, 'utf8');
const totals = {
  linesFound: 0, linesHit: 0,
  functionsFound: 0, functionsHit: 0,
  branchesFound: 0, branchesHit: 0
};
for (const line of info.split(/\r?\n/)) {
  let match;
  if ((match = /^LF:(\d+)$/.exec(line))) totals.linesFound += Number(match[1]);
  else if ((match = /^LH:(\d+)$/.exec(line))) totals.linesHit += Number(match[1]);
  else if ((match = /^FNF:(\d+)$/.exec(line))) totals.functionsFound += Number(match[1]);
  else if ((match = /^FNH:(\d+)$/.exec(line))) totals.functionsHit += Number(match[1]);
  else if ((match = /^BRF:(\d+)$/.exec(line))) totals.branchesFound += Number(match[1]);
  else if ((match = /^BRH:(\d+)$/.exec(line))) totals.branchesHit += Number(match[1]);
}
const percent = (hit, found) => found ? hit * 100 / found : 100;
const actual = {
  lines: percent(totals.linesHit, totals.linesFound),
  functions: percent(totals.functionsHit, totals.functionsFound),
  branches: percent(totals.branchesHit, totals.branchesFound)
};

console.log('\nCobertura real de assets/js (Node.js test runner):');
for (const key of ['lines', 'functions', 'branches']) {
  console.log(`  ${key}: ${actual[key].toFixed(2)}% (mínimo ${thresholds[key]}%)`);
}
console.log(`Informe LCOV: ${reportPath}`);

const failed = Object.entries(thresholds).filter(([key, minimum]) => actual[key] + Number.EPSILON < minimum);
if (failed.length) {
  console.error(`Umbral de cobertura incumplido: ${failed.map(([key, minimum]) => `${key} ${actual[key].toFixed(2)}% < ${minimum}%`).join('; ')}`);
  process.exitCode = 1;
}
