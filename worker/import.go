package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
)

const verifiedCoverageChecksum = "adeb99733363fce2eba380a21228e69a6cfbc27a40bb685c3c7700f136532d5b"

func verifyRelease(path, expected string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	actual := hex.EncodeToString(digest[:])
	if expected == "" || actual != expected {
		return errors.New("dataset release checksum mismatch")
	}
	return nil
}
