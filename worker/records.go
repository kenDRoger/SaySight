package main

import (
	"encoding/json"
	"log"
	"net/http"
)

func recordsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rows, err := loadReleaseRows()
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
	if encodeErr := json.NewEncoder(w).Encode(records); encodeErr != nil {
		log.Printf("records response unavailable: %v", encodeErr)
	}
}
