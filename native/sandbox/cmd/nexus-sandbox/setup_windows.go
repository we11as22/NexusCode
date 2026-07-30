//go:build windows

package main

import (
	"encoding/json"
	"io"

	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsnative"
)

func runPlatformSetup(elevated bool) error {
	if elevated {
		return windowsnative.SetupElevated()
	}
	return windowsnative.Setup()
}

func writePlatformStatus(output io.Writer) error {
	return json.NewEncoder(output).Encode(windowsnative.Status())
}

func runWindowsCommandRunner(envelopePath string) int {
	return windowsnative.RunCommandRunner(envelopePath)
}

func verifyPlatformInstallation() error {
	return windowsnative.VerifyInstallation()
}
