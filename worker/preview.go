package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
)

func previewHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	rows, err := loadReleaseRows()
	if err != nil {
		http.Error(w, "coverage release unavailable", http.StatusServiceUnavailable)
		return
	}
	count := 0
	yearValue := r.URL.Query().Get("year")
	yearsValue := r.URL.Query().Get("years")
	statusValue := r.URL.Query().Get("status")
	var year *int
	selectedYears := map[int]bool{}
	if yearsValue != "" {
		if yearValue != "" {
			http.Error(w, "use year or years, not both", http.StatusBadRequest)
			return
		}
		for _, value := range strings.Split(yearsValue, ",") {
			parsed, parseErr := strconv.Atoi(value)
			if parseErr != nil || parsed < 2000 || parsed > 2026 {
				http.Error(w, "years must be between 2000 and 2026", http.StatusBadRequest)
				return
			}
			selectedYears[parsed] = true
		}
		if len(selectedYears) == 0 {
			http.Error(w, "at least one year is required", http.StatusBadRequest)
			return
		}
	}
	if yearValue != "" {
		parsed, parseErr := strconv.Atoi(yearValue)
		if parseErr != nil || parsed < 2000 || parsed > 2026 {
			http.Error(w, "year must be between 2000 and 2026", http.StatusBadRequest)
			return
		}
		year = &parsed
	}
	for _, row := range rows {
		if year != nil && row.Year != *year {
			continue
		}
		if len(selectedYears) > 0 && !selectedYears[row.Year] {
			continue
		}
		if statusValue != "" && row.Status != statusValue {
			continue
		}
		count++
	}
	w.Header().Set("Content-Type", "application/json")
	if encodeErr := json.NewEncoder(w).Encode(map[string]any{"matching_rows": count, "source_rows": len(rows), "filters": r.URL.Query()}); encodeErr != nil {
		log.Printf("preview response unavailable: %v", encodeErr)
	}
}
