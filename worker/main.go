package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
)

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

func main() {
	http.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(healthResponse{Status: "ok", Service: "saysight-worker"})
	})
	http.HandleFunc("/preview", previewHandler)
	http.HandleFunc("/records", recordsHandler)
	http.HandleFunc("/validate-import", importValidationHandler)
	http.HandleFunc("/analyze", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var job analysisJob
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024*1024)).Decode(&job); err != nil {
			http.Error(w, "invalid JSON request", http.StatusBadRequest)
			return
		}
		request := job.analysisRequest
		rows := job.Rows
		if len(rows) == 0 {
			coveragePath := os.Getenv("COVERAGE_PATH")
			if coveragePath == "" {
				coveragePath = "data/coverage.json"
			}
			var err error
			rows, err = loadVerifiedCoverage(coveragePath)
			if err != nil {
				http.Error(w, "coverage release unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		result, err := runAnalysis(rows, request)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnprocessableEntity)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "validation": result.Validation, "reproducibility_status": result.Reproducibility})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	log.Println("SaySight worker listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
