//go:build !windows

package main

import (
	"encoding/json"
	"errors"
	"io"
	"runtime"
)

func runPlatformSetup(bool) error {
	return errors.New("explicit sandbox setup is only required on Windows")
}

func writePlatformStatus(output io.Writer) error {
	return json.NewEncoder(output).Encode(map[string]any{
		"state":  "ready",
		"detail": runtime.GOOS + " sandbox is configured at runtime",
	})
}

func runWindowsCommandRunner(string) int {
	return 125
}

func verifyPlatformReadiness() error {
	return nil
}

func auditPlatformInstallation() error {
	return nil
}
