package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/parquet-go/parquet-go"
	"github.com/xuri/excelize/v2"
)

// parseImportData returns the parsed rows as JSON objects. The row cap is
// enforced by parseTabularImport before any data is returned.
func parseImportData(name string, data []byte) (importSummary, []map[string]any, error) {
	summary, err := parseTabularImport(name, data)
	if err != nil {
		return importSummary{}, nil, err
	}
	ext := strings.ToLower(strings.TrimPrefix(name[strings.LastIndex(name, "."):], "."))
	rows := make([]map[string]any, 0, summary.Rows)
	switch ext {
	case "csv":
		records, err := csv.NewReader(bytes.NewReader(data)).ReadAll()
		if err != nil || len(records) < 1 {
			return importSummary{}, nil, errors.New("CSV must contain a header")
		}
		for _, record := range records[1:] {
			row := map[string]any{}
			for index, column := range summary.Columns {
				if index < len(record) {
					row[column] = record[index]
				}
			}
			rows = append(rows, row)
		}
	case "json":
		if err := json.Unmarshal(data, &rows); err != nil {
			return importSummary{}, nil, errors.New("JSON must be an array of objects")
		}
	case "xlsx":
		file, err := excelize.OpenReader(bytes.NewReader(data))
		if err != nil {
			return importSummary{}, nil, errors.New("invalid XLSX workbook")
		}
		defer file.Close()
		sheets := file.GetSheetList()
		if len(sheets) == 0 {
			return importSummary{}, nil, errors.New("XLSX has no worksheets")
		}
		values, err := file.GetRows(sheets[0])
		if err != nil || len(values) == 0 {
			return importSummary{}, nil, errors.New("XLSX first worksheet has no header")
		}
		for _, record := range values[1:] {
			row := map[string]any{}
			for index, column := range summary.Columns {
				if index < len(record) {
					row[column] = record[index]
				}
			}
			rows = append(rows, row)
		}
	case "parquet":
		reader := parquet.NewGenericReader[map[string]any](bytes.NewReader(data))
		defer reader.Close()
		buffer := make([]map[string]any, 1024)
		for {
			read, err := reader.Read(buffer)
			for _, row := range buffer[:read] {
				rows = append(rows, row)
			}
			if err == io.EOF {
				break
			}
			if err != nil {
				return importSummary{}, nil, fmt.Errorf("unable to read parquet rows: %w", err)
			}
		}
	default:
		return importSummary{}, nil, errors.New("unsupported dataset format")
	}
	return summary, rows, nil
}

// importRowsHandler returns a bounded page so large files never arrive in one
// API response; the API writes each page to the normalized import table.
func importRowsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	offset, err := strconv.Atoi(r.URL.Query().Get("offset"))
	if err != nil || offset < 0 {
		http.Error(w, "invalid offset", http.StatusBadRequest)
		return
	}
	limit, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || limit < 1 || limit > 1000 {
		http.Error(w, "invalid limit", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImportBytes+1))
	if err != nil {
		http.Error(w, "unable to read dataset", http.StatusBadRequest)
		return
	}
	summary, rows, err := parseImportData(r.URL.Query().Get("filename"), data)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	page := []map[string]any{}
	if offset < len(rows) {
		end := offset + limit
		if end > len(rows) {
			end = len(rows)
		}
		page = rows[offset:end]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"format": summary.Format, "columns": summary.Columns, "total_rows": len(rows), "offset": offset, "rows": page})
}
