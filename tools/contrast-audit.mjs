#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = [
  await readFile(resolve(root, 'assets/css/app.css'), 'utf8'),
  await readFile(resolve(root, 'assets/css/accessibility.css'), 'utf8')
].join('\n');

function parseDeclarations(block) {
  const values = {};
  for (const match of block.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-f]{3,8})\b/gi)) {
    values[match[1]] = match[2];
  }
  return values;
}

function themeVariables(selector) {
  const result = {};
  const matcher = selector === ':root'
    ? /:root\s*\{([^}]*)\}/g
    : /html\[data-theme="dark"\]\s*\{([^}]*)\}/g;
  for (const block of css.matchAll(matcher)) Object.assign(result, parseDeclarations(block[1]));
  return result;
}

function rgb(hex) {
  const value = hex.slice(1);
  const full = value.length === 3 ? value.split('').map(char => char + char).join('') : value.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Color no compatible: ${hex}`);
  return [0, 2, 4].map(index => parseInt(full.slice(index, index + 2), 16) / 255);
}

function luminance(hex) {
  const channels = rgb(hex).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const base = themeVariables(':root');
const dark = { ...base, ...themeVariables('html[data-theme="dark"]') };
const errors = [];
const report = [];

function verify(themeName, variables, buttonBackgrounds) {
  const required = ['ink', 'muted', 'text-soft', 'paper', 'paper-2', 'accent-deep', 'focus-ring'];
  for (const variable of required) {
    if (!variables[variable]) errors.push(`${themeName}: falta --${variable} en CSS.`);
  }
  if (required.some(variable => !variables[variable])) return;

  const textPairs = [
    ['texto principal sobre fondo', variables.ink, variables.paper, 4.5],
    ['texto principal sobre superficie', variables.ink, variables['paper-2'], 4.5],
    ['texto secundario sobre fondo', variables.muted, variables.paper, 4.5],
    ['texto secundario sobre superficie', variables.muted, variables['paper-2'], 4.5],
    ['texto suave sobre superficie', variables['text-soft'], variables['paper-2'], 4.5],
    ['texto de navegación/acento', variables['accent-deep'], variables['paper-2'], 4.5],
    ['texto de identificación de la barra superior', variables.muted, themeName === 'oscuro' ? '#24211f' : '#fefcf8', 4.5]
  ];
  for (const [label, foreground, background, minimum] of textPairs) {
    const value = contrast(foreground, background);
    report.push({ theme: themeName, label, ratio: value, minimum });
    if (value < minimum) errors.push(`${themeName}: ${label} ${value.toFixed(2)}:1 (mínimo ${minimum}:1).`);
  }

  const focusSurfaces = themeName === 'oscuro'
    ? [[variables.paper, 'fondo'], [variables['paper-2'], 'superficie'], [variables['surface-tint'] || '#302925', 'panel lateral oscuro']]
    : [[variables.paper, 'fondo'], [variables['paper-2'], 'superficie'], ['#f4ede5', 'panel lateral claro']];
  for (const [background, label] of focusSurfaces) {
    const value = contrast(variables['focus-ring'], background);
    report.push({ theme: themeName, label: `anillo de foco sobre ${label}`, ratio: value, minimum: 3 });
    if (value < 3) errors.push(`${themeName}: anillo de foco sobre ${label} ${value.toFixed(2)}:1 (mínimo 3:1).`);
  }

  for (const background of buttonBackgrounds) {
    const value = contrast('#fffaf5', background);
    report.push({ theme: themeName, label: 'texto del botón primario', ratio: value, minimum: 4.5 });
    if (value < 4.5) errors.push(`${themeName}: texto del botón primario ${value.toFixed(2)}:1 (mínimo 4.5:1).`);
  }
}

verify('claro', base, [base.accent || '#8b5b4d', '#794e43']);
verify('oscuro', dark, ['#8b594b', '#704538']);

if (errors.length) {
  console.error('AUDITORÍA DE CONTRASTE FALLIDA');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Auditoría de contraste correcta: ${report.length} combinaciones verificadas en tema claro y oscuro.`);
  for (const item of report) console.log(`${item.theme.padEnd(6)} ${item.label.padEnd(40)} ${item.ratio.toFixed(2)}:1`);
}
