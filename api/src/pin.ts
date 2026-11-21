import { inferSchema, type InferredSchema } from './schemaInfer.js';
import type { Format } from './uploadPolicy.js';

export type LicenceStatus = 'confirmed' | 'unconfirmed' | 'not-stated';

// The key is the immutable address of one fetched snapshot in object storage.
export function releaseKey(connectorId: string, datasetId: string, sha256: string): string {
  return `connectors/${connectorId}/${datasetId}/${sha256}`;
}

// 'not-stated' means the portal explicitly reported no licence; a missing field
// is only 'unconfirmed', which S10a requires us to disclose rather than block.
export function licenceStatus(licence?: string | null): LicenceStatus {
  if (licence === undefined || licence === null) return 'unconfirmed';
  const value = licence.trim();
  if (!value || /^(none|not[- ]stated)$/i.test(value)) return 'not-stated';
  return 'confirmed';
}

export function pinSummary(connectorId: string, datasetId: string, bytes: number, status: LicenceStatus): string {
  return `Pinned ${datasetId} from ${connectorId} (${bytes} bytes) with licence status ${status}.`;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

// Schema is a bounded inference over the pinned bytes, never a claim about the
// whole portal dataset. XLSX/Parquet stay opaque here: their bytes are pinned
// intact, but no column claim is made from them.
export function inferReleaseSchema(bytes: Uint8Array, format: Format): InferredSchema {
  const text = Buffer.from(bytes).toString('utf8');
  if (format === 'json') {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return inferSchema([]); }
    const rows = Array.isArray(parsed) ? parsed
      : record(parsed) && Array.isArray(parsed.data) ? parsed.data : [];
    return inferSchema(rows.filter(record));
  }
  if (format === 'csv') {
    const [header = '', ...lines] = text.split(/\r?\n/).filter((line) => line.length > 0);
    const names = header.split(',');
    return inferSchema(lines.map((line) => Object.fromEntries(line.split(',').map((value, index) => [names[index] ?? `column_${index + 1}`, value]))));
  }
  return inferSchema([]);
}
