package main

import "testing"

func TestParseTabularImport(t *testing.T) {
	csvSummary, err := parseTabularImport("budget.csv", []byte("year,amount\n2020,10\n"))
	if err != nil || csvSummary.Rows != 1 {
		t.Fatalf("CSV parse failed: %#v %v", csvSummary, err)
	}
	jsonSummary, err := parseTabularImport("budget.json", []byte(`[{"year":2020,"amount":10}]`))
	if err != nil || jsonSummary.Rows != 1 {
		t.Fatalf("JSON parse failed: %#v %v", jsonSummary, err)
	}
	if _, err := parseTabularImport("budget.csv", []byte("invalid")); err == nil {
		t.Fatal("expected malformed CSV to fail")
	}
}
