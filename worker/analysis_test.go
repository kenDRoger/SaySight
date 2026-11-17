package main

import (
	"encoding/json"
	"testing"
)

func number(value float64) *float64 { return &value }

func TestCompareRequiresComparablePairAndReportsDifference(t *testing.T) {
	rows := []coverageRow{
		{Year: 2020, Status: "published_source_baseline", AmountPesos: number(100), Scopes: map[string]any{"scope": float64(100)}},
		{Year: 2021, Status: "published_source_baseline", AmountPesos: number(125), Scopes: map[string]any{"scope": float64(125)}},
	}
	got, err := runAnalysis(rows, analysisRequest{Recipe: "compare", CompareYears: []int{2020, 2021}})
	if err != nil {
		t.Fatal(err)
	}
	result, ok := got.Result.(compareResult)
	if !ok {
		t.Fatalf("expected compareResult, got %T", got.Result)
	}
	if result.Difference != 25 || result.PercentChange == nil || *result.PercentChange != 25 {
		t.Fatalf("unexpected comparison: %#v", result)
	}
	if got.Validation.Status != "Pass" {
		t.Fatalf("expected passed validation: %#v", got.Validation)
	}
}

func TestCompareRejectsIncomparableCoverage(t *testing.T) {
	rows := []coverageRow{
		{Year: 2020, Status: "published_source_baseline", AmountPesos: number(100), Scopes: map[string]any{"a": float64(100)}},
		{Year: 2021, Status: "published_source_baseline", AmountPesos: number(125), Scopes: map[string]any{"b": float64(125)}},
	}
	if _, err := runAnalysis(rows, analysisRequest{Recipe: "compare", CompareYears: []int{2020, 2021}}); err == nil {
		t.Fatal("expected incompatible scope rejection")
	}
}

func TestDistributionIncludesPercentages(t *testing.T) {
	rows := []coverageRow{{Year: 2020, Status: "baseline"}, {Year: 2021, Status: "baseline"}, {Year: 2022, Status: "partial"}}
	got, err := runAnalysis(rows, analysisRequest{Recipe: "distribution"})
	if err != nil {
		t.Fatal(err)
	}
	result := got.Result.(distributionResult)
	if len(result.Groups) != 2 || result.Groups[0].Percentage+result.Groups[1].Percentage != 100 {
		t.Fatalf("unexpected distribution: %#v", result)
	}
}

func TestRankUsesStableTieBreak(t *testing.T) {
	rows := []coverageRow{{Year: 2021, AmountPesos: number(100)}, {Year: 2020, AmountPesos: number(100)}}
	got, err := runAnalysis(rows, analysisRequest{Recipe: "rank"})
	if err != nil {
		t.Fatal(err)
	}
	result := got.Result.([]rankedAmount)
	if result[0].Year != 2020 || result[1].Year != 2021 {
		t.Fatalf("unstable tie order: %#v", result)
	}
}

func TestTrendReportsOnlyComparableAdjacentChanges(t *testing.T) {
	rows := []coverageRow{
		{Year: 2020, Status: "baseline", AmountPesos: number(100), Scopes: map[string]any{"scope": float64(100)}},
		{Year: 2021, Status: "baseline", AmountPesos: number(110), Scopes: map[string]any{"scope": float64(110)}},
		{Year: 2022, Status: "partial", AmountPesos: number(120), Scopes: map[string]any{"scope": float64(120)}},
	}
	got, err := runAnalysis(rows, analysisRequest{Recipe: "change_over_time"})
	if err != nil {
		t.Fatal(err)
	}
	result := got.Result.([]trendPoint)
	if result[1].Change == nil || *result[1].Change != 10 || result[1].PercentChange == nil || *result[1].PercentChange != 10 {
		t.Fatalf("missing adjacent change: %#v", result[1])
	}
	if result[2].PercentChange != nil {
		t.Fatalf("incomparable coverage should not get a percentage: %#v", result[2])
	}
}

func TestSummaryDoesNotAggregateAcrossYears(t *testing.T) {
	rows := []coverageRow{{Year: 2020, AmountPesos: number(100)}, {Year: 2021, AmountPesos: number(200)}}
	got, err := runAnalysis(rows, analysisRequest{Recipe: "summary"})
	if err != nil {
		t.Fatal(err)
	}
	result := got.Result.(summaryResult)
	if result.YearCount != 2 || result.AmountRowCount != 2 {
		t.Fatalf("unexpected summary: %#v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if _, exists := fields["amount_pesos_total"]; exists {
		t.Fatal("summary must not sum potentially incomparable annual appropriations")
	}
}
