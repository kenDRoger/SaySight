package main

import (
	"encoding/json"
	"io"
	"net/http"
)

func importValidationHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImportBytes+1))
	if err != nil {
		http.Error(w, "unable to read dataset", http.StatusBadRequest)
		return
	}
	summary, err := parseTabularImport(r.URL.Query().Get("filename"), data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(summary)
}
