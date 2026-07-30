//go:build darwin

package platform

import (
	"github.com/we11as22/NexusCode/native/sandbox/internal/platform/macos"
	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func BuildCommand(request protocol.Request) (Command, error) {
	command, err := macos.BuildCommand(request)
	if err != nil {
		return Command{}, err
	}
	return Command{Program: command.Program, Args: command.Args, Sandbox: "seatbelt"}, nil
}
