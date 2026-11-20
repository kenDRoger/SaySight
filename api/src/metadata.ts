// Publication metadata rules. A draft can be parsed successfully yet still be
// unsafe to publish: it needs an attributable source, reuse terms, coverage,
// field definitions, and stated limitations.
export type PublicationMetadata = {
  publisher: unknown;
  sourceUrl: unknown;
  license: unknown;
  coverage: unknown;
  fields: unknown;
  limitations: unknown;
};

export type MetadataError =
  | 'publisher_required'
  | 'source_url_required'
  | 'license_required'
  | 'coverage_required'
  | 'fields_required'
  | 'limitations_required';

export function validateMetadata(input: PublicationMetadata): { ok: true } | { ok: false; errors: MetadataError[] } {
  const errors: MetadataError[] = [];
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!text(input.publisher)) errors.push('publisher_required');
  if (!text(input.sourceUrl) || !/^https?:\/\//i.test(String(input.sourceUrl))) errors.push('source_url_required');
  if (!text(input.license) || input.license === 'license not confirmed') errors.push('license_required');
  const coverage = input.coverage as { fiscalYears?: unknown } | undefined;
  if (!coverage || !Array.isArray(coverage.fiscalYears) || coverage.fiscalYears.length === 0 ||
      !coverage.fiscalYears.every((year) => Number.isInteger(year))) errors.push('coverage_required');
  if (!Array.isArray(input.fields) || input.fields.length === 0 ||
      !input.fields.every((field) => field && typeof field === 'object' && typeof (field as { name?: unknown }).name === 'string')) errors.push('fields_required');
  if (!Array.isArray(input.limitations)) errors.push('limitations_required');
  return errors.length ? { ok: false, errors } : { ok: true };
}
