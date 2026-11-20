// MVP-C rules for general uploads. Written and tested ahead of wiring: nothing
// imports this yet, so no behaviour changes until the import stage connects it.
export const allowedFormats = ['csv', 'json', 'xlsx', 'parquet'] as const;
export type Format = (typeof allowedFormats)[number];

export const maxUploadBytes = 100 * 1024 * 1024;
export const maxImportRows = 1_000_000;

// A private draft becomes publishable only through a maintainer decision; no
// validation result can promote it on its own.
export type DraftState = 'private-draft' | 'validated' | 'published' | 'quarantined';
export type Role = 'submitter' | 'reviewer' | 'maintainer';

export function detectFormat(filename: string): Format | undefined {
  const extension = filename.toLowerCase().split('.').pop();
  return (allowedFormats as readonly string[]).includes(extension ?? '') ? (extension as Format) : undefined;
}

export type UploadCheck =
  | { ok: true; format: Format }
  | { ok: false; error: 'unsupported_format' | 'empty_file' | 'file_too_large' | 'name_required' };

export function checkUpload(input: { filename: string; bytes: number }): UploadCheck {
  if (!input.filename.trim()) return { ok: false, error: 'name_required' };
  const format = detectFormat(input.filename);
  if (!format) return { ok: false, error: 'unsupported_format' };
  if (input.bytes <= 0) return { ok: false, error: 'empty_file' };
  if (input.bytes > maxUploadBytes) return { ok: false, error: 'file_too_large' };
  return { ok: true, format };
}

// Row caps are enforced before anything reaches analysis, so an oversized import
// is refused rather than trimmed.
export function checkRows(rows: number): { ok: true } | { ok: false; error: 'empty_dataset' | 'too_many_rows' } {
  if (rows <= 0) return { ok: false, error: 'empty_dataset' };
  if (rows > maxImportRows) return { ok: false, error: 'too_many_rows' };
  return { ok: true };
}

export function checkPublish(input: { state: DraftState; role: Role }):
  | { ok: true }
  | { ok: false; error: 'maintainer_required' | 'not_validated' | 'already_published' | 'quarantined' } {
  if (input.state === 'quarantined') return { ok: false, error: 'quarantined' };
  if (input.state === 'published') return { ok: false, error: 'already_published' };
  if (input.state !== 'validated') return { ok: false, error: 'not_validated' };
  if (input.role !== 'maintainer') return { ok: false, error: 'maintainer_required' };
  return { ok: true };
}

// Every quarantined upload keeps a machine-readable reason for the maintainer.
export const quarantineReasons = ['checksum_mismatch', 'schema_invalid', 'sensitive_columns', 'row_limit_exceeded'] as const;
export type QuarantineReason = (typeof quarantineReasons)[number];
export const isQuarantineReason = (value: unknown): value is QuarantineReason =>
  typeof value === 'string' && (quarantineReasons as readonly string[]).includes(value);
