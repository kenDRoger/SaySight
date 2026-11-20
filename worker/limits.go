package main

import (
	"fmt"
	"net/http"
	"time"
)

// Bounded job limits. Size caps bound memory; these bound work per request.
var (
	maxImportRows     = 1_000_000
	maxAnalysisRows   = 1_000_000
	maxConcurrentJobs = 4
	jobTimeout        = 5 * time.Minute
)

func checkImportRowLimit(rows int) error {
	if rows > maxImportRows {
		return fmt.Errorf("dataset exceeds %d row limit", maxImportRows)
	}
	return nil
}

func checkAnalysisRowLimit(rows int) error {
	if rows > maxAnalysisRows {
		return fmt.Errorf("analysis job exceeds %d row limit", maxAnalysisRows)
	}
	return nil
}

// concurrencyGate bounds in-flight heavy jobs. A full gate rejects immediately
// instead of queueing, so callers see a bounded failure rather than growing latency.
type concurrencyGate chan struct{}

func newConcurrencyGate(limit int) concurrencyGate { return make(concurrencyGate, limit) }

func (gate concurrencyGate) wrap(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case gate <- struct{}{}:
			defer func() { <-gate }()
			next(w, r)
		default:
			w.Header().Set("Retry-After", "1")
			http.Error(w, "worker is at its concurrent job limit", http.StatusTooManyRequests)
		}
	}
}
