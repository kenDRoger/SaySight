package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestDecodeVerifiedReleaseAcceptsFixture(t *testing.T) {
	data, err := os.ReadFile("data/coverage.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	rows, err := decodeVerifiedRelease(data)
	if err != nil {
		t.Fatalf("verified release rejected: %v", err)
	}
	if len(rows) != 27 {
		t.Fatalf("expected 27 coverage rows, got %d", len(rows))
	}
}

func TestDecodeVerifiedReleaseRejectsTamperedBytes(t *testing.T) {
	data, err := os.ReadFile("data/coverage.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	// Still-valid JSON with one changed value: only the checksum can catch this.
	var rows []map[string]any
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	rows[0]["status"] = "altered"
	tampered, err := json.Marshal(rows)
	if err != nil {
		t.Fatalf("encode tampered release: %v", err)
	}
	if _, err := decodeVerifiedRelease(tampered); err == nil {
		t.Fatal("expected checksum mismatch for altered release bytes")
	}
}

func TestObjectStoreDisabledWithoutEndpoint(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "")
	store, err := objectStoreFromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store != nil {
		t.Fatal("object storage must stay disabled without S3_ENDPOINT")
	}
}

func TestObjectStoreConfiguredFromEnv(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "object-storage:9000")
	t.Setenv("S3_BUCKET", "custom-bucket")
	t.Setenv("S3_ACCESS_KEY", "key")
	t.Setenv("S3_SECRET_KEY", "secret")
	store, err := objectStoreFromEnv()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if store == nil || store.bucket != "custom-bucket" {
		t.Fatalf("expected configured store, got %+v", store)
	}
}

func TestLoadReleaseRowsFallsBackToLocalArtifact(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "")
	t.Setenv("COVERAGE_PATH", "data/coverage.json")
	rows, err := loadReleaseRows()
	if err != nil {
		t.Fatalf("fallback load failed: %v", err)
	}
	if len(rows) != 27 {
		t.Fatalf("expected 27 rows from fallback, got %d", len(rows))
	}
}

func writeFile(path, content string) error {
	return os.WriteFile(path, []byte(content), 0o644)
}

func TestLoadReleaseRowsFallsBackWhenStoreUnreachable(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "127.0.0.1:1")
	t.Setenv("S3_ACCESS_KEY", "key")
	t.Setenv("S3_SECRET_KEY", "secret")
	t.Setenv("COVERAGE_PATH", "data/coverage.json")
	rows, err := loadReleaseRows()
	if err != nil {
		t.Fatalf("unreachable store must fall back to the local artifact: %v", err)
	}
	if len(rows) != 27 {
		t.Fatalf("expected 27 rows from the fallback, got %d", len(rows))
	}
}

func TestLoadReleaseRowsRecoversFromBadCoveragePath(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "")
	t.Setenv("COVERAGE_PATH", t.TempDir()+"/absent.json")
	rows, err := loadReleaseRows()
	if err != nil {
		t.Fatalf("expected recovery to the bundled artifact: %v", err)
	}
	if len(rows) != 27 {
		t.Fatalf("expected 27 rows, got %d", len(rows))
	}
}
