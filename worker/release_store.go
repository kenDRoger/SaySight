package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/minio/minio-go/v7"
)

// The store is injected so the handler can be tested without object storage.
type releaseBlobStore interface {
	statRelease(ctx context.Context, key string) (int64, bool, error)
	putRelease(ctx context.Context, key string, data []byte) error
}

func (store *objectStore) statRelease(ctx context.Context, key string) (int64, bool, error) {
	info, err := store.client.StatObject(ctx, store.bucket, key, minio.StatObjectOptions{})
	if err == nil {
		return info.Size, true, nil
	}
	if storesNothing(err) {
		return 0, false, nil
	}
	return 0, false, err
}

func (store *objectStore) putRelease(ctx context.Context, key string, data []byte) error {
	_, err := store.client.PutObject(ctx, store.bucket, key, bytes.NewReader(data), int64(len(data)),
		minio.PutObjectOptions{ContentType: "application/octet-stream"})
	return err
}

type storeReleaseResponse struct {
	Key    string `json:"key"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

func validReleaseRequest(key, checksum string) bool {
	parts := strings.Split(key, "/")
	if len(parts) != 4 || parts[0] != "connectors" || parts[3] != checksum {
		return false
	}
	for _, part := range parts[:3] {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\\r\n") {
			return false
		}
	}
	if len(checksum) != 64 {
		return false
	}
	_, err := hex.DecodeString(checksum)
	return err == nil
}

func writeStoreReleaseError(w http.ResponseWriter, status int, code string, extra map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"error": code, "message": code}
	for key, value := range extra {
		body[key] = value
	}
	_ = json.NewEncoder(w).Encode(body)
}

func storeReleaseHandler(store releaseBlobStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		key := r.URL.Query().Get("key")
		checksum := r.URL.Query().Get("sha256")
		if !validReleaseRequest(key, checksum) {
			writeStoreReleaseError(w, http.StatusBadRequest, "invalid_release_request", nil)
			return
		}
		if r.ContentLength > maxImportBytes {
			writeStoreReleaseError(w, http.StatusRequestEntityTooLarge, "request_too_large", nil)
			return
		}
		// MaxBytesReader also bounds a body whose length was not declared.
		data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxImportBytes+1))
		if err != nil || len(data) > maxImportBytes {
			writeStoreReleaseError(w, http.StatusRequestEntityTooLarge, "request_too_large", nil)
			return
		}
		digest := sha256.Sum256(data)
		if hex.EncodeToString(digest[:]) != checksum {
			writeStoreReleaseError(w, http.StatusUnprocessableEntity, "checksum_mismatch", nil)
			return
		}
		size, exists, err := store.statRelease(r.Context(), key)
		if err != nil {
			writeStoreReleaseError(w, http.StatusServiceUnavailable, "storage_unavailable", nil)
			return
		}
		if exists {
			writeStoreReleaseError(w, http.StatusConflict, "already_stored", map[string]any{"bytes": size})
			return
		}
		if err := store.putRelease(r.Context(), key, data); err != nil {
			writeStoreReleaseError(w, http.StatusServiceUnavailable, "storage_unavailable", nil)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(storeReleaseResponse{Key: key, Bytes: len(data), SHA256: checksum})
	}
}
