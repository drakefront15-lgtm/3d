/**
 * Produce the Artifact-ready fragment from index.html.
 *
 *   node scripts/build-artifact.mjs [outfile]
 *
 * The Artifact host supplies its own <!doctype>, <head> and <body>, so the
 * published file is the same page with the document wrapper and the
 * document-level <meta> tags removed. Everything else — title, font links,
 * styles, markup, script — is byte-identical to index.html.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = process.argv[2] || path.join(ROOT, "artifact.html");

let s = await readFile(path.join(ROOT, "index.html"), "utf8");

const drop = [
  /^<!DOCTYPE html>\n/i,
  /^<html[^>]*>\n/im,
  /^<\/html>\n?/im,
  /^<head>\n/im,
  /^<\/head>\n/im,
  /^<body>\n/im,
  /^<\/body>\n/im,
  /^<meta charset[^>]*>\n/im,
  /^<meta name="viewport"[^>]*>\n/im,
  /^<meta name="theme-color"[^>]*>\n/im,
  /^<meta name="color-scheme"[^>]*>\n/im,
  /^<meta name="description"[^>]*>\n/im,
];
for (const re of drop) s = s.replace(re, "");

if (/^<\/?(!doctype|html|head|body)\b/im.test(s)) throw new Error("document wrapper survived the strip");
if (!/<title>/i.test(s)) throw new Error("title tag missing from the fragment");

await writeFile(out, s.trim() + "\n");
console.log(`wrote ${out} (${s.length} bytes)`);
