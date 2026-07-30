//go:build windows

package platform

import (
	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsnative"
)

func BuildCommand(_ protocol.Request) (Command, error) {
	if err := windowsnative.RequireReady(); err != nil {
		return Command{}, err
	}
	return Command{
		Sandbox: "windows-elevated",
		Start:   windowsnative.Start,
	}, nil
}
