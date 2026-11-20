package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const releaseSnapshotKey = "releases/bettergov-gaa-coverage-2026-11-07/coverage.json"

type objectStore struct {
	client *minio.Client
	bucket string
}

// objectStoreFromEnv returns nil when S3_ENDPOINT is unset, which keeps the
// checksum-verified local artifact as the documented development fallback.
func objectStoreFromEnv() (*objectStore, error) {
	endpoint := os.Getenv("S3_ENDPOINT")
	if endpoint == "" {
		return nil, nil
	}
	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), ""),
		Secure: strings.EqualFold(os.Getenv("S3_SECURE"), "true"),
	})
	if err != nil {
		return nil, err
	}
	bucket := os.Getenv("S3_BUCKET")
	if bucket == "" {
		bucket = "saysight"
	}
	return &objectStore{client: client, bucket: bucket}, nil
}

// ensureReleaseSnapshot writes the raw release once; an existing object is never
// overwritten, so the stored snapshot stays immutable.
func (store *objectStore) ensureReleaseSnapshot(ctx context.Context, data []byte) error {
	if _, err := store.client.StatObject(ctx, store.bucket, releaseSnapshotKey, minio.StatObjectOptions{}); err == nil {
		return nil
	} else if !storesNothing(err) {
		// A transport or authorization failure must not be read as "absent", which
		// would attempt to overwrite a snapshot this process cannot see.
		return err
	}
	if err := store.client.MakeBucket(ctx, store.bucket, minio.MakeBucketOptions{}); err != nil {
		var response minio.ErrorResponse
		if !(errors.As(err, &response) && response.Code == "BucketAlreadyOwnedByYou") {
			return err
		}
	}
	_, err := store.client.PutObject(ctx, store.bucket, releaseSnapshotKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{ContentType: "application/json"})
	return err
}

func storesNothing(err error) bool {
	var response minio.ErrorResponse
	if errors.As(err, &response) {
		return response.StatusCode == http.StatusNotFound || response.Code == "NoSuchKey" || response.Code == "NoSuchBucket"
	}
	return false
}

func (store *objectStore) readReleaseSnapshot(ctx context.Context) ([]byte, error) {
	object, err := store.client.GetObject(ctx, store.bucket, releaseSnapshotKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	defer object.Close()
	return io.ReadAll(object)
}
