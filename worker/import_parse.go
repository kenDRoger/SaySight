package main

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/parquet-go/parquet-go"
	"github.com/xuri/excelize/v2"
)

type importSummary struct {
	Format  string   `json:"format"`
	Columns []string `json:"columns"`
	Rows    int      `json:"rows"`
}

func parseTabularImport(name string, data []byte) (importSummary, error) {
	summary, err := parseImportRows(name, data)
	if err != nil {
		return importSummary{}, err
	}
	if err := checkImportRowLimit(summary.Rows); err != nil {
		return importSummary{}, err
	}
	return summary, nil
}

func parseImportRows(name string, data []byte) (importSummary, error) {
	if err := validateImport(name, data); err != nil {
		return importSummary{}, err
	}
	switch strings.ToLower(strings.TrimPrefix(name[strings.LastIndex(name, "."):], ".")) {
	case "csv":
		records, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
		if err != nil || len(records) < 1 {
			return importSummary{}, errors.New("CSV must contain a header")
		}
		if len(records[0]) == 0 {
			return importSummary{}, errors.New("CSV header is empty")
		}
		return importSummary{"csv", records[0], len(records) - 1}, nil
	case "json":
		var records []map[string]any
		if err := json.Unmarshal(data, &records); err != nil {
			return importSummary{}, errors.New("JSON must be an array of objects")
		}
		if len(records) == 0 {
			return importSummary{}, errors.New("JSON dataset is empty")
		}
		columns := make([]string, 0, len(records[0]))
		for key := range records[0] {
			columns = append(columns, key)
		}
		return importSummary{"json", columns, len(records)}, nil
	case "xlsx":
		file, err := excelize.OpenReader(bytes.NewReader(data))
		if err != nil {
			return importSummary{}, errors.New("invalid XLSX workbook")
		}
		defer file.Close()
		sheets := file.GetSheetList()
		if len(sheets) == 0 {
			return importSummary{}, errors.New("XLSX has no worksheets")
		}
		rows, err := file.GetRows(sheets[0])
		if err != nil || len(rows) == 0 || len(rows[0]) == 0 {
			return importSummary{}, errors.New("XLSX first worksheet has no header")
		}
		return importSummary{"xlsx", rows[0], len(rows) - 1}, nil
	case "parquet":
		reader := parquet.NewReader(bytes.NewReader(data))
		defer reader.Close()
		columns := make([]string, 0, len(reader.Schema().Fields()))
		for _, field := range reader.Schema().Fields() {
			columns = append(columns, fmt.Sprint(field))
		}
		return importSummary{"parquet", columns, int(reader.NumRows())}, nil
	default:
		return importSummary{}, errors.New("unsupported dataset format")
	}
}
