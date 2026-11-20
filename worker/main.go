package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
}

func main() {
	startupCtx, cancel := context.WithTimeout(context.Background(), startupSnapshotTimeout)
	defer cancel()
	if err := publishSnapshotWithRetry(startupCtx); err != nil {
		log.Printf("release snapshot unavailable: %v", err)
	}
	log.Println("SaySight worker listening on :8080")
	log.Fatal(newServer(":8080").ListenAndServe())
}

func newServer(addr string) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           newMux(),
		ReadHeaderTimeout: 10 * time.Second,
		// A 100 MiB import must finish reading within this window; 5m allows ~0.33 MiB/s.
		ReadTimeout:  jobTimeout,
		WriteTimeout: jobTimeout,
		IdleTimeout:  2 * time.Minute,
	}
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	jobs := newConcurrencyGate(maxConcurrentJobs)
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if encodeErr := json.NewEncoder(w).Encode(healthResponse{Status: "ok", Service: "saysight-worker"}); encodeErr != nil {
			log.Printf("health response unavailable: %v", encodeErr)
		}
	})
	mux.HandleFunc("/preview", previewHandler)
	mux.HandleFunc("/records", recordsHandler)
	mux.HandleFunc("/validate-import", jobs.wrap(importValidationHandler))
	mux.HandleFunc("/analyze", jobs.wrap(analyzeHandler))
	return mux
}

func analyzeHandler(w http.ResponseWriter, r *http.Request) {
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
		var err error
		rows, err = loadReleaseRows()
		if err != nil {
			http.Error(w, "coverage release unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	if err := checkAnalysisRowLimit(len(rows)); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		if encodeErr := json.NewEncoder(w).Encode(map[string]any{"error": err.Error()}); encodeErr != nil {
			log.Printf("row-limit response unavailable: %v", encodeErr)
		}
		return
	}
	result, err := runAnalysis(rows, request)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		if encodeErr := json.NewEncoder(w).Encode(map[string]any{"error": err.Error(), "validation": result.Validation, "reproducibility_status": result.Reproducibility}); encodeErr != nil {
			log.Printf("validation response unavailable: %v", encodeErr)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if encodeErr := json.NewEncoder(w).Encode(result); encodeErr != nil {
		log.Printf("analysis response unavailable: %v", encodeErr)
	}
}
