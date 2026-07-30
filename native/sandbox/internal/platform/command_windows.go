//go:build windows

package platform

import (
	"errors"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func BuildCommand(_ protocol.Request) (Command, error) {
	// This is deliberately fail-closed until the restricted-token + Job Object
	// backend is linked. Never substitute an unsandboxed CreateProcess call.
	return Command{}, errors.New("Windows restricted-token sandbox backend is unavailable")
}
