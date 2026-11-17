package main

import "errors"

type normalizedCoverage struct {
	DatasetReleaseID string
	FiscalYear       int
	CoverageStatus   string
	SourceRowCount   int
	AmountPesos      *float64
	Scopes           map[string]any
	Notes            []string
}

func normalizeCoverage(releaseID string, rows []coverageRow) ([]normalizedCoverage, error) {
	if releaseID == "" {
		return nil, errors.New("dataset release id is required")
	}
	if len(rows) == 0 {
		return nil, errors.New("coverage release is empty")
	}
	result := make([]normalizedCoverage, 0, len(rows))
	for _, row := range rows {
		if row.Year < 2000 || row.Year > 2026 {
			return nil, errors.New("coverage year is outside the verified release range")
		}
		if row.Status == "" {
			return nil, errors.New("coverage status is required")
		}
		result = append(result, normalizedCoverage{releaseID, row.Year, row.Status, row.Rows, row.AmountPesos, row.Scopes, row.Notes})
	}
	return result, nil
}
