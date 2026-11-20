package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestParseImportDataCSV(t *testing.T) {
	summary, rows, err := parseImportData("rows.csv", []byte("year,status\n2024,GAA\n2025,GAA\n"))
	if err != nil {
		t.Fatal(err)
	}
	if summary.Rows != 2 || len(rows) != 2 {
		t.Fatalf("expected two rows, got summary %#v and %d rows", summary, len(rows))
	}
	if rows[0]["year"] != "2024" || rows[1]["status"] != "GAA" {
		t.Fatalf("unexpected row data: %#v", rows)
	}
}

func TestParseImportDataJSON(t *testing.T) {
	_, rows, err := parseImportData("rows.json", []byte(`[{"year":2024,"status":"GAA"}]`))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0]["status"] != "GAA" {
		t.Fatalf("unexpected row data: %#v", rows)
	}
}

func TestImportRowsHandlerPagination(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/normalize-import?filename=rows.csv&offset=1&limit=1", strings.NewReader("year,status\n2024,GAA\n2025,GAA\n"))
	recorder := httptest.NewRecorder()
	importRowsHandler(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"offset":1`) || !strings.Contains(recorder.Body.String(), `"total_rows":2`) {
		t.Fatalf("unexpected response: %s", recorder.Body.String())
	}
}
