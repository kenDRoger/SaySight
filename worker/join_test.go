package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestJoinedSummaryMatchesExplicitKeys(t *testing.T) {
	response, err := runJoinedSummary(joinRequest{
		Recipe: "joined_summary", Keys: []string{"fiscal_year"},
		LeftRows:  []map[string]any{{"fiscal_year": 2024, "value": "a"}, {"fiscal_year": 2025}},
		RightRows: []map[string]any{{"fiscal_year": 2024, "value": "b"}, {"fiscal_year": 2026}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Result.MatchedRows != 1 || response.Result.UnmatchedLeft != 1 || response.Result.UnmatchedRight != 1 {
		t.Fatalf("unexpected diagnostics: %#v", response.Result)
	}
	if response.Validation.Status != "Pass" {
		t.Fatalf("expected pass, got %#v", response.Validation)
	}
}

func TestJoinedSummaryReportsDuplicateKeys(t *testing.T) {
	response, err := runJoinedSummary(joinRequest{
		Recipe: "joined_summary", Keys: []string{"fiscal_year", "agency"},
		LeftRows:  []map[string]any{{"fiscal_year": 2024, "agency": "DBM"}},
		RightRows: []map[string]any{{"fiscal_year": 2024, "agency": "DBM"}, {"fiscal_year": 2024, "agency": "DBM"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if response.Result.DuplicateKeys != 1 || response.Result.MatchedRows != 0 {
		t.Fatalf("duplicate keys were not excluded: %#v", response.Result)
	}
}

func TestJoinedSummaryRefusesBadRequests(t *testing.T) {
	for _, request := range []joinRequest{
		{Recipe: "summary", Keys: []string{"year"}},
		{Recipe: "joined_summary"},
		{Recipe: "joined_summary", Keys: []string{"year", "year"}},
	} {
		if _, err := runJoinedSummary(request); err == nil {
			t.Fatalf("expected refusal for %#v", request)
		}
	}
}

func TestJoinedAnalysisHandler(t *testing.T) {
	body := `{"recipe":"joined_summary","keys":["fiscal_year"],"left_rows":[{"fiscal_year":2024}],"right_rows":[{"fiscal_year":2024}]}`
	request := httptest.NewRequest(http.MethodPost, "/analyze-join", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	joinedAnalysisHandler(recorder, request)
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), `"matched_rows":1`) {
		t.Fatalf("status %d body %s", recorder.Code, recorder.Body.String())
	}
}
