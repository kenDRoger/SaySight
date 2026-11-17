export type NormalizedCoverage = {
  DatasetReleaseID: string;
  FiscalYear: number;
  CoverageStatus: string;
  SourceRowCount: number;
  AmountPesos?: number;
  Scopes?: Record<string, unknown>;
  Notes: string[];
};
