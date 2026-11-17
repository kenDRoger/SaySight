package main

import "testing"

func TestVerifyRelease(t *testing.T) {
	if err := verifyRelease("data/coverage.json", verifiedCoverageChecksum); err != nil {
		t.Fatal(err)
	}
	if err := verifyRelease("data/coverage.json", "bad"); err == nil {
		t.Fatal("expected checksum mismatch")
	}
}
