package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
)

type CommandBuilder func(protocol.Request) (runner.Command, error)

func Run(
	ctx context.Context,
	input io.Reader,
	stdout io.Writer,
	stderr io.Writer,
	control io.Writer,
	build CommandBuilder,
) int {
	data, err := io.ReadAll(io.LimitReader(input, protocol.MaxRequestBytes+1))
	if err != nil {
		writeError(control, "", "request_read_failed", err)
		return 125
	}
	if len(data) > protocol.MaxRequestBytes {
		writeError(control, "", "invalid_request", fmt.Errorf("request exceeds %d bytes", protocol.MaxRequestBytes))
		return 125
	}
	request, err := protocol.DecodeRequest(data)
	if err != nil {
		writeError(control, "", "invalid_request", err)
		return 125
	}
	command, err := build(request)
	if err != nil {
		writeError(control, request.ExecutionID, "sandbox_setup_failed", err)
		return 125
	}
	result := runner.Run(ctx, request, command, stdout, stderr, control)
	if result.SetupError != nil {
		return 125
	}
	if result.TimedOut {
		return 124
	}
	return result.ExitCode
}

func writeError(control io.Writer, executionID, code string, err error) {
	if control == nil {
		return
	}
	_ = json.NewEncoder(control).Encode(protocol.ControlMessage{
		Version:     protocol.ProtocolVersion,
		Type:        protocol.ControlError,
		ExecutionID: executionID,
		ErrorCode:   code,
		Message:     err.Error(),
	})
}
