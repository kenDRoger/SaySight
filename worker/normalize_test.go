package main

import "testing"

func TestNormalizeCoverage(t *testing.T) {
	rows := []coverageRow{{Year: 2020, Status: "published_source_baseline", Rows: 1}}
	normalized, err := normalizeCoverage("bettergov-gaa-coverage-2026-11-07", rows)
	if err != nil || len(normalized) != 1 || normalized[0].FiscalYear != 2020 {
		t.Fatalf("unexpected normalized result: %#v, %v", normalized, err)
	}
	if _, err := normalizeCoverage("", rows); err == nil {
		t.Fatal("expected missing release id to fail")
	}
}
