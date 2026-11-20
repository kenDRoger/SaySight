package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func withLimit(t *testing.T, target *int, value int) {
	t.Helper()
	previous := *target
	*target = value
	t.Cleanup(func() { *target = previous })
}

func TestImportRejectsRowsAboveLimit(t *testing.T) {
	withLimit(t, &maxImportRows, 2)
	data := []byte("year,status\n2000,a\n2001,b\n2002,c\n")
	if _, err := parseTabularImport("coverage.csv", data); err == nil {
		t.Fatal("expected dataset row limit error")
	}
	within := []byte("year,status\n2000,a\n2001,b\n")
	if _, err := parseTabularImport("coverage.csv", within); err != nil {
		t.Fatalf("rows within limit must pass: %v", err)
	}
}

func TestImportRejectsJSONRowsAboveLimit(t *testing.T) {
	withLimit(t, &maxImportRows, 1)
	data := []byte(`[{"year":2000},{"year":2001}]`)
	if _, err := parseTabularImport("coverage.json", data); err == nil {
		t.Fatal("expected dataset row limit error")
	}
}

func TestAnalyzeRejectsRowsAboveLimit(t *testing.T) {
	withLimit(t, &maxAnalysisRows, 1)
	body := `{"recipe":"summary","rows":[{"year":2000,"status":"a","rows":1},{"year":2001,"status":"b","rows":1}]}`
	request := httptest.NewRequest(http.MethodPost, "/analyze", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	newMux().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for oversized analysis job, got %d", recorder.Code)
	}
}

func TestRejectsConcurrentJobsAboveLimit(t *testing.T) {
	gate := newConcurrencyGate(1)
	release := make(chan struct{})
	started := make(chan struct{})
	handler := gate.wrap(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusOK)
	})

	first := httptest.NewRecorder()
	firstDone := make(chan struct{})
	go func() {
		handler(first, httptest.NewRequest(http.MethodPost, "/analyze", nil))
		close(firstDone)
	}()
	<-started

	second := httptest.NewRecorder()
	handler(second, httptest.NewRequest(http.MethodPost, "/analyze", nil))
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 while a job is in flight, got %d", second.Code)
	}
	if second.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After header on a rejected job")
	}

	close(release)
	<-firstDone
	if first.Code != http.StatusOK {
		t.Fatalf("expected in-flight job to complete, got %d", first.Code)
	}
}

func TestWorkerServerEnforcesDurationTimeouts(t *testing.T) {
	server := newServer(":0")
	if server.ReadHeaderTimeout == 0 || server.ReadTimeout == 0 || server.WriteTimeout == 0 || server.IdleTimeout == 0 {
		t.Fatalf("expected bounded duration timeouts, got %+v", server)
	}
	if server.Handler == nil {
		t.Fatal("expected server handler to be configured")
	}
}
