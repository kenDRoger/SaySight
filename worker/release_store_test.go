package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type fakeReleaseStore struct {
	mu      sync.Mutex
	objects map[string][]byte
	puts    []string
}

func newFakeReleaseStore() *fakeReleaseStore {
	return &fakeReleaseStore{objects: map[string][]byte{}}
}

func (store *fakeReleaseStore) statRelease(_ context.Context, key string) (int64, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	data, ok := store.objects[key]
	return int64(len(data)), ok, nil
}

func (store *fakeReleaseStore) putRelease(_ context.Context, key string, data []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.puts = append(store.puts, key)
	store.objects[key] = append([]byte(nil), data...)
	return nil
}

func testReleaseKey(checksum string) string {
	return "connectors/bettergov/gaa-coverage/" + checksum
}

func storeReleaseSHA(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func storeReleaseRequest(store releaseBlobStore, data []byte, key, checksum string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/store-release?key="+key+"&sha256="+checksum, bytes.NewReader(data))
	recorder := httptest.NewRecorder()
	storeReleaseHandler(store)(recorder, request)
	return recorder
}

func TestStoreReleaseStoresMatchingBytesOnce(t *testing.T) {
	fake := newFakeReleaseStore()
	data := []byte("the exact portal bytes")
	checksum := storeReleaseSHA(data)
	response := storeReleaseRequest(fake, data, testReleaseKey(checksum), checksum)
	if response.Code != http.StatusOK {
		t.Fatalf("want 200, got %d: %s", response.Code, response.Body.String())
	}
	var body struct {
		Key    string `json:"key"`
		Bytes  int    `json:"bytes"`
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body.Key != testReleaseKey(checksum) || body.Bytes != len(data) || body.SHA256 != checksum {
		t.Fatalf("unexpected stored release: %+v", body)
	}
	if len(fake.puts) != 1 || !bytes.Equal(fake.objects[testReleaseKey(checksum)], data) {
		t.Fatalf("bytes must be stored exactly once, got puts %v", fake.puts)
	}
}

func TestStoreReleaseRefusesExistingKey(t *testing.T) {
	fake := newFakeReleaseStore()
	checksum := storeReleaseSHA([]byte("other bytes"))
	fake.objects[testReleaseKey(checksum)] = []byte("already stored")
	response := storeReleaseRequest(fake, []byte("other bytes"), testReleaseKey(checksum), checksum)
	if response.Code != http.StatusConflict {
		t.Fatalf("want 409, got %d: %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["error"] != "already_stored" || body["bytes"] != float64(len("already stored")) {
		t.Fatalf("409 must name the conflict and the stored size, got %+v", body)
	}
	if len(fake.puts) != 0 {
		t.Fatalf("an existing object must never be overwritten, got %v", fake.puts)
	}
}

func TestStoreReleaseRefusesChecksumMismatch(t *testing.T) {
	fake := newFakeReleaseStore()
	checksum := strings.Repeat("b", 64)
	response := storeReleaseRequest(fake, []byte("tampered"), testReleaseKey(checksum), checksum)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d: %s", response.Code, response.Body.String())
	}
	assertStoreReleaseError(t, response.Body.String(), "checksum_mismatch")
	if len(fake.puts) != 0 {
		t.Fatalf("mismatched bytes must never be stored, got %v", fake.puts)
	}
}

func TestStoreReleaseRefusesOversizedBody(t *testing.T) {
	fake := newFakeReleaseStore()
	data := []byte("small")
	checksum := storeReleaseSHA(data)
	request := httptest.NewRequest(http.MethodPost, "/store-release?key="+testReleaseKey(checksum)+"&sha256="+checksum, bytes.NewReader(data))
	request.ContentLength = maxImportBytes + 1
	recorder := httptest.NewRecorder()
	storeReleaseHandler(fake)(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("want 413, got %d: %s", recorder.Code, recorder.Body.String())
	}
	assertStoreReleaseError(t, recorder.Body.String(), "request_too_large")
	if len(fake.puts) != 0 {
		t.Fatalf("an oversized body must never be stored, got %v", fake.puts)
	}
}

func assertStoreReleaseError(t *testing.T, body, code string) {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("decode response %q: %v", body, err)
	}
	if decoded["error"] != code || decoded["message"] != code {
		t.Fatalf("want %s, got %+v", code, decoded)
	}
}
