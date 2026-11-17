package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"strings"
)

const maxImportBytes = 100 * 1024 * 1024

func validateImport(name string, data []byte) error {
	if len(data) == 0 {
		return errors.New("empty dataset file")
	}
	if len(data) > maxImportBytes {
		return errors.New("dataset file exceeds 100 MiB limit")
	}
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".json":
		if !bytes.HasPrefix(bytes.TrimSpace(data), []byte("[")) && !bytes.HasPrefix(bytes.TrimSpace(data), []byte("{")) {
			return errors.New("invalid JSON dataset")
		}
	case ".csv":
		if !bytes.Contains(data, []byte(",")) {
			return errors.New("CSV header or delimiter is missing")
		}
	case ".xlsx":
		if !bytes.HasPrefix(data, []byte("PK\x03\x04")) {
			return errors.New("invalid XLSX container")
		}
	case ".parquet":
		if len(data) < 8 || string(data[:4]) != "PAR1" || string(data[len(data)-4:]) != "PAR1" {
			return errors.New("invalid Parquet container")
		}
	default:
		return errors.New("unsupported dataset format")
	}
	return nil
}
