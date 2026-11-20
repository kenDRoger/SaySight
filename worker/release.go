package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"time"
)

const (
	startupSnapshotTimeout = 30 * time.Second
	startupSnapshotRetry   = 2 * time.Second
)

func localCoveragePath() string {
	if path := os.Getenv("COVERAGE_PATH"); path != "" {
		return path
	}
	return "data/coverage.json"
}

// decodeVerifiedRelease accepts release bytes only when they match the recorded
// checksum, so an object-storage snapshot and the local artifact share one gate.
func decodeVerifiedRelease(data []byte) ([]coverageRow, error) {
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != verifiedCoverageChecksum {
		return nil, errors.New("dataset release checksum mismatch")
	}
	var rows []coverageRow
	if err := json.Unmarshal(data, &rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, errors.New("coverage release is empty")
	}
	return rows, nil
}

// loadReleaseRows prefers the immutable object-storage snapshot and falls back to
// the local artifact when object storage is unconfigured or unreachable.
func loadReleaseRows() ([]coverageRow, error) {
	if store, err := objectStoreFromEnv(); err != nil {
		return nil, err
	} else if store != nil {
		if data, getErr := store.readReleaseSnapshot(context.Background()); getErr == nil {
			return decodeVerifiedRelease(data)
		}
	}
	rows, err := loadVerifiedCoverage(localCoveragePath())
	if err == nil {
		return rows, nil
	}
	if fallback := "data/coverage.json"; localCoveragePath() != fallback {
		return loadVerifiedCoverage(fallback)
	}
	return nil, err
}

// publishSnapshotWithRetry keeps trying until the snapshot is stored or the
// startup window closes, so a store that is still booting does not leave the
// release unsnapshotted.
func publishSnapshotWithRetry(ctx context.Context) error {
	for {
		err := publishReleaseSnapshot(ctx)
		if err == nil || ctx.Err() != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return err
		case <-time.After(startupSnapshotRetry):
		}
	}
}

// publishReleaseSnapshot stores the raw release once at startup. Failure is not
// fatal: the local artifact still serves analyses.
func publishReleaseSnapshot(ctx context.Context) error {
	store, err := objectStoreFromEnv()
	if err != nil || store == nil {
		return err
	}
	data, err := os.ReadFile(localCoveragePath())
	if err != nil {
		return err
	}
	if _, err := decodeVerifiedRelease(data); err != nil {
		return err
	}
	return store.ensureReleaseSnapshot(ctx, data)
}
