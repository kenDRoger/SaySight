package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

type joinRequest struct {
	Recipe    string           `json:"recipe"`
	Keys      []string         `json:"keys"`
	LeftRows  []map[string]any `json:"left_rows"`
	RightRows []map[string]any `json:"right_rows"`
}

type joinResult struct {
	MatchedRows    int `json:"matched_rows"`
	UnmatchedLeft  int `json:"unmatched_left"`
	UnmatchedRight int `json:"unmatched_right"`
	DuplicateKeys  int `json:"duplicate_right_keys"`
	InputLeftRows  int `json:"input_left_rows"`
	InputRightRows int `json:"input_right_rows"`
}

type joinResponse struct {
	Recipe        string           `json:"recipe"`
	RecipeVersion string           `json:"recipe_version"`
	Result        joinResult       `json:"result"`
	Validation    validationReport `json:"validation"`
	Warnings      []string         `json:"warnings"`
	Limitations   []string         `json:"limitations"`
}

const joinRecipeVersion = "joined-v1"

func keyFor(row map[string]any, keys []string) (string, bool) {
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		value, ok := row[key]
		if !ok || value == nil {
			return "", false
		}
		parts = append(parts, strings.TrimSpace(fmt.Sprint(value)))
	}
	return strings.Join(parts, "\x1f"), true
}

func runJoinedSummary(request joinRequest) (joinResponse, error) {
	fail := func(message string) (joinResponse, error) {
		return joinResponse{Recipe: request.Recipe, RecipeVersion: joinRecipeVersion,
			Validation: validationReport{Status: "Fail", Checks: []string{message}},
			Warnings:   []string{}, Limitations: []string{}}, errors.New(message)
	}
	if request.Recipe != "joined_summary" {
		return fail("unsupported joined recipe")
	}
	if len(request.Keys) == 0 {
		return fail("explicit join keys are required")
	}
	seen := map[string]bool{}
	for _, key := range request.Keys {
		if strings.TrimSpace(key) == "" || seen[key] {
			return fail("join keys must be non-empty and unique")
		}
		seen[key] = true
	}
	if len(request.LeftRows) > maxAnalysisRows || len(request.RightRows) > maxAnalysisRows {
		return fail("joined analysis row limit exceeded")
	}

	right := map[string]int{}
	for _, row := range request.RightRows {
		key, ok := keyFor(row, request.Keys)
		if !ok {
			continue
		}
		right[key]++
	}
	result := joinResult{InputLeftRows: len(request.LeftRows), InputRightRows: len(request.RightRows)}
	used := map[string]bool{}
	warnings := []string{}
	missingLeft := 0
	for _, row := range request.LeftRows {
		key, ok := keyFor(row, request.Keys)
		if !ok {
			missingLeft++
			continue
		}
		if right[key] != 1 {
			continue
		}
		result.MatchedRows++
		used[key] = true
	}
	for key, count := range right {
		if count > 1 {
			result.DuplicateKeys++
		} else if !used[key] {
			result.UnmatchedRight++
		}
	}
	result.UnmatchedLeft = len(request.LeftRows) - result.MatchedRows
	if missingLeft > 0 {
		warnings = append(warnings, "left rows with missing join keys were excluded")
	}
	return joinResponse{Recipe: request.Recipe, RecipeVersion: joinRecipeVersion, Result: result,
		Validation: validationReport{Status: "Pass", Checks: []string{"only curated releases were joined", "explicit keys used"}},
		Warnings:   warnings, Limitations: []string{"Only the curated release pair and recipe version are supported."}}, nil
}

func joinedAnalysisHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImportBytes+1))
	if err != nil {
		http.Error(w, "unable to read join request", http.StatusBadRequest)
		return
	}
	var request joinRequest
	if err := json.Unmarshal(data, &request); err != nil {
		http.Error(w, "invalid join request", http.StatusBadRequest)
		return
	}
	response, err := runJoinedSummary(request)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		if encodeErr := json.NewEncoder(w).Encode(response); encodeErr != nil {
			http.Error(w, "unable to write response", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if encodeErr := json.NewEncoder(w).Encode(response); encodeErr != nil {
		http.Error(w, "unable to write response", http.StatusInternalServerError)
	}
}
