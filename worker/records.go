package main

import (
	"encoding/json"
	"net/http"
	"os"
)

func recordsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := os.Getenv("COVERAGE_PATH")
	if path == "" {
		path = "data/coverage.json"
	}
	rows, err := loadVerifiedCoverage(path)
	if err != nil {
		http.Error(w, "coverage release unavailable", http.StatusServiceUnavailable)
		return
	}
	records, err := normalizeCoverage("bettergov-gaa-coverage-2026-11-07", rows)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(records)
}
