import type { ConnectorDataset } from '../connectors.js';

// Scraped sources expose datasets as links in HTML, or expose nothing readable at
// all. These helpers stay pure so an adapter's behaviour is pinned by fixtures
// instead of today's markup.

const skip = /^(#|mailto:|javascript:|tel:)/i;

export function extractLinks(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1] ?? '').trim();
    if (!href || skip.test(href)) continue;
    let absolute: string;
    try { absolute = new URL(href, baseUrl).toString(); } catch { continue; }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }
  return links;
}

const datasetHint = /(\/datasets?\/|\/data\/|\/database|download|\.(csv|json|xlsx|parquet)(\?|$))/i;

export function datasetLinks(html: string, baseUrl: string): Array<{ url: string; text: string }> {
  const found: Array<{ url: string; text: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = (match[1] ?? '').trim();
    if (!href || skip.test(href)) continue;
    let absolute: string;
    try { absolute = new URL(href, baseUrl).toString(); } catch { continue; }
    const text = (match[2] ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const looksLikeDataset = datasetHint.test(absolute) || datasetHint.test(text);
    if (!looksLikeDataset || seen.has(absolute)) continue;
    seen.add(absolute);
    found.push({ url: absolute, text: text || absolute });
  }
  return found;
}

// An SPA answers 200 with a small shell for every path, including nonsense ones, so
// "200 OK" must never be read as "here is a dataset list".
export function looksLikeSpaShell(html: string): boolean {
  const small = html.length < 12_000;
  const hasShell = /<app-root|<div\s+id=["']root["']|ng-version=|window\.__NUXT__/i.test(html);
  return small && hasShell && datasetLinks(html, 'https://example.invalid').length < 5;
}

export type ProbeStatus = 'ok' | 'spa-shell' | 'forbidden' | 'unreachable';
export type ProbeResult = { status: ProbeStatus; httpStatus: number | null; datasets: ConnectorDataset[]; message: string };

const MAX_DATASETS = 50;

export async function probeHtml(url: string, fetchImpl: typeof fetch): Promise<{ html?: string; result?: ProbeResult }> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return { result: { status: 'unreachable', httpStatus: null, datasets: [], message: `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}` } };
  }
  if (response.status === 403) return { result: { status: 'forbidden', httpStatus: 403, datasets: [], message: `${url} refused the request with HTTP 403` } };
  if (!response.ok) return { result: { status: 'unreachable', httpStatus: response.status, datasets: [], message: `${url} answered HTTP ${response.status}` } };
  const html = await response.text().catch(() => '');
  return { html, result: undefined };
}

// A scraped portal's datasets are the links it actually exposes, capped so one page
// cannot flood the catalog. Nothing is named, counted, or licensed on the portal's
// behalf.
export function datasetsFromHtml(html: string, baseUrl: string, status = 200): ProbeResult {
  if (looksLikeSpaShell(html)) {
    return { status: 'spa-shell', httpStatus: status, datasets: [],
      message: `${baseUrl} renders its datasets in the browser; no document API is published` };
  }
  const links = datasetLinks(html, baseUrl).slice(0, MAX_DATASETS);
  return { status: 'ok', httpStatus: status,
    datasets: links.map((link) => ({ id: link.url, name: link.text, description: '' })),
    message: `${baseUrl} exposes ${links.length} dataset link${links.length === 1 ? '' : 's'} in HTML` };
}

export async function probeScraped(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  const probed = await probeHtml(url, fetchImpl);
  if (probed.result) return probed.result;
  return datasetsFromHtml(probed.html ?? '', url);
}
