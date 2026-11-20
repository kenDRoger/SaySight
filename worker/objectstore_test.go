package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// dechunkSignedBody strips AWS streaming-signature chunk framing, which the Go
// server does not decode for us.
func dechunkSignedBody(body []byte) []byte {
	if !bytes.Contains(body, []byte(";chunk-signature=")) {
		return body
	}
	out := []byte{}
	for {
		index := bytes.IndexByte(body, '\n')
		if index < 0 {
			return out
		}
		header := string(body[:index])
		if semi := strings.IndexByte(header, ';'); semi >= 0 {
			header = header[:semi]
		}
		size, err := strconv.ParseInt(strings.TrimSpace(header), 16, 64)
		if err != nil {
			return out
		}
		body = body[index+1:]
		if size == 0 {
			return out
		}
		out = append(out, body[:size]...)
		body = body[size:]
		body = bytes.TrimPrefix(body, []byte("\r\n"))
	}
}

// fakeS3 answers only what minio-go needs for StatObject/PutObject/GetObject.
type fakeS3 struct {
	mu     sync.Mutex
	object []byte
	puts   []string
	stat   int
	get    int
}

func (fake *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Query().Has("location"):
		w.Header().Set("Content-Type", "application/xml")
		w.Write([]byte(`<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>`))
	case r.Method == http.MethodHead:
		if fake.stat != 0 && fake.stat != http.StatusOK {
			w.WriteHeader(fake.stat)
			return
		}
		if fake.object == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(fake.object)))
		w.Header().Set("ETag", `"stub"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodPut:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fake.puts = append(fake.puts, r.URL.Path)
		fake.object = dechunkSignedBody(body)
		w.WriteHeader(http.StatusOK)
	case r.Method == http.MethodGet:
		if fake.get != 0 && fake.get != http.StatusOK {
			w.WriteHeader(fake.get)
			return
		}
		if fake.object == nil {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(fake.object)))
		w.Header().Set("ETag", `"stub"`)
		w.Header().Set("Last-Modified", time.Now().UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusOK)
		w.Write(fake.object)
	default:
		w.WriteHeader(http.StatusOK)
	}
}

func newFakeStore(t *testing.T, fake *fakeS3) *objectStore {
	t.Helper()
	server := httptest.NewServer(fake)
	t.Cleanup(server.Close)
	t.Setenv("S3_ENDPOINT", strings.TrimPrefix(server.URL, "http://"))
	t.Setenv("S3_BUCKET", "saysight")
	t.Setenv("S3_ACCESS_KEY", "key")
	t.Setenv("S3_SECRET_KEY", "secret")
	store, err := objectStoreFromEnv()
	if err != nil {
		t.Fatalf("configure store: %v", err)
	}
	return store
}

func TestEnsureReleaseSnapshotSkipsExistingObject(t *testing.T) {
	fake := &fakeS3{object: []byte("already stored")}
	store := newFakeStore(t, fake)
	if err := store.ensureReleaseSnapshot(context.Background(), []byte("release")); err != nil {
		t.Fatalf("ensure snapshot: %v", err)
	}
	if len(fake.puts) != 0 {
		t.Fatalf("existing snapshot must not be overwritten, got puts %v", fake.puts)
	}
}

func TestEnsureReleaseSnapshotDoesNotWriteOnForeignStatError(t *testing.T) {
	fake := &fakeS3{stat: http.StatusForbidden}
	store := newFakeStore(t, fake)
	if err := store.ensureReleaseSnapshot(context.Background(), []byte("release")); err == nil {
		t.Fatal("expected a permission error to surface instead of writing")
	}
	if len(fake.puts) != 0 {
		t.Fatalf("must not write when the snapshot cannot be inspected, got %v", fake.puts)
	}
}

func TestLoadReleaseRowsSurfacesSnapshotChecksumMismatch(t *testing.T) {
	fake := &fakeS3{object: []byte(`[{"year":2000,"status":"tampered"}]`)}
	newFakeStore(t, fake)
	t.Setenv("COVERAGE_PATH", "data/coverage.json")
	if _, err := loadReleaseRows(); err == nil {
		t.Fatal("altered snapshot must surface a checksum error, not fall back to the local artifact")
	}
}

func TestPublishReleaseSnapshotRefusesUnverifiedLocalFile(t *testing.T) {
	fake := &fakeS3{}
	store := newFakeStore(t, fake)
	_ = store
	path := t.TempDir() + "/coverage.json"
	if err := writeFile(path, `[{"year":2000,"status":"tampered"}]`); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	t.Setenv("COVERAGE_PATH", path)
	if err := publishReleaseSnapshot(context.Background()); err == nil {
		t.Fatal("expected unverified local release to be refused")
	}
	if len(fake.puts) != 0 {
		t.Fatalf("unverified bytes must not be uploaded, got %v", fake.puts)
	}
}

func TestPublishReleaseSnapshotRespectsContextDeadline(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "127.0.0.1:1")
	t.Setenv("S3_ACCESS_KEY", "key")
	t.Setenv("S3_SECRET_KEY", "secret")
	t.Setenv("COVERAGE_PATH", "data/coverage.json")
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	started := time.Now()
	if err := publishSnapshotWithRetry(ctx); err == nil {
		t.Fatal("expected publishing to fail against an unreachable store")
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("publishing must be bounded by its context, took %s", elapsed)
	}
}

func TestPublishThenLoadRoundTrip(t *testing.T) {
	fake := &fakeS3{}
	store := newFakeStore(t, fake)
	t.Setenv("COVERAGE_PATH", "data/coverage.json")
	if err := publishReleaseSnapshot(context.Background()); err != nil {
		t.Fatalf("publish snapshot: %v", err)
	}
	if _, err := store.readReleaseSnapshot(context.Background()); err != nil {
		t.Fatalf("read snapshot back: %v", err)
	}
	// The local artifact is gone, so the rows can only come from object storage.
	t.Setenv("COVERAGE_PATH", t.TempDir()+"/absent.json")
	rows, err := loadReleaseRows()
	if err != nil {
		t.Fatalf("load from snapshot: %v", err)
	}
	if len(rows) != 27 {
		t.Fatalf("expected 27 rows read back from the snapshot, got %d", len(rows))
	}
}
