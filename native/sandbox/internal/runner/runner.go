package runner

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

type Command struct {
	Program string
	Args    []string
	Sandbox string
	Start   StartFunc
}

type StartFunc func(
	context.Context,
	protocol.Request,
	io.Writer,
	io.Writer,
) (Process, error)

type Process interface {
	Wait() error
	Terminate()
	Kill()
	ExitCode(error) int
}

type Result struct {
	ExitCode   int
	TimedOut   bool
	SetupError error
}

func Run(
	parent context.Context,
	request protocol.Request,
	command Command,
	stdout io.Writer,
	stderr io.Writer,
	control io.Writer,
) Result {
	if err := request.Validate(); err != nil {
		writeControl(control, protocol.ControlMessage{
			Version: protocol.ProtocolVersion, Type: protocol.ControlError,
			ExecutionID: request.ExecutionID, ErrorCode: "invalid_request", Message: err.Error(),
		})
		return Result{ExitCode: 1, SetupError: err}
	}
	if command.Program == "" && command.Start == nil {
		err := errors.New("sandbox command program is empty")
		writeControl(control, protocol.ControlMessage{
			Version: protocol.ProtocolVersion, Type: protocol.ControlError,
			ExecutionID: request.ExecutionID, ErrorCode: "invalid_command", Message: err.Error(),
		})
		return Result{ExitCode: 1, SetupError: err}
	}

	// The request timeout is an execution budget, not a sandbox preparation
	// budget. Native policy/ACL preparation and the bounded spawn handshake run
	// under the caller context; start the command timer only after the process
	// exists and a started event can be emitted.
	process, err := startProcess(parent, request, command, stdout, stderr)
	if err != nil {
		if stderr != nil {
			_, _ = fmt.Fprintf(stderr, "nexus-sandbox: %v\n", err)
		}
		writeControl(control, protocol.ControlMessage{
			Version: protocol.ProtocolVersion, Type: protocol.ControlError,
			ExecutionID: request.ExecutionID, Sandbox: command.Sandbox,
			ErrorCode: "spawn_failed", Message: err.Error(),
		})
		return Result{ExitCode: 1, SetupError: err}
	}
	writeControl(control, protocol.ControlMessage{
		Version: protocol.ProtocolVersion, Type: protocol.ControlStarted,
		ExecutionID: request.ExecutionID, Sandbox: command.Sandbox,
	})

	ctx := parent
	cancel := func() {}
	if request.TimeoutMillis > 0 {
		ctx, cancel = context.WithTimeout(parent, time.Duration(request.TimeoutMillis)*time.Millisecond)
	}
	defer cancel()

	waited := make(chan error, 1)
	go func() { waited <- process.Wait() }()

	var waitErr error
	timedOut := false
	select {
	case waitErr = <-waited:
	case <-ctx.Done():
		timedOut = errors.Is(ctx.Err(), context.DeadlineExceeded)
		process.Terminate()
		select {
		case waitErr = <-waited:
		case <-time.After(500 * time.Millisecond):
			process.Kill()
			waitErr = <-waited
		}
	}

	exitCode := process.ExitCode(waitErr)
	writeControl(control, protocol.ControlMessage{
		Version: protocol.ProtocolVersion, Type: protocol.ControlExited,
		ExecutionID: request.ExecutionID, Sandbox: command.Sandbox,
		ExitCode: &exitCode, TimedOut: timedOut,
	})
	return Result{ExitCode: exitCode, TimedOut: timedOut}
}

func startProcess(
	ctx context.Context,
	request protocol.Request,
	command Command,
	stdout io.Writer,
	stderr io.Writer,
) (Process, error) {
	if command.Start != nil {
		return command.Start(ctx, request, stdout, stderr)
	}
	cmd := exec.Command(command.Program, command.Args...)
	cmd.Dir = request.Cwd
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = buildEnvironment(request)
	prepareProcess(cmd)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &execProcess{cmd: cmd}, nil
}

type execProcess struct {
	cmd *exec.Cmd
}

func (process *execProcess) Wait() error {
	return process.cmd.Wait()
}

func (process *execProcess) Terminate() {
	terminateProcessTree(process.cmd)
}

func (process *execProcess) Kill() {
	killProcessTree(process.cmd)
}

func (process *execProcess) ExitCode(waitErr error) int {
	return exitCodeOf(process.cmd, waitErr)
}

func buildEnvironment(request protocol.Request) []string {
	environment := []string{}
	if request.InheritEnv {
		environment = append(environment, os.Environ()...)
	}
	for key, value := range request.Environment {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func writeControl(writer io.Writer, message protocol.ControlMessage) {
	if writer == nil {
		return
	}
	_ = json.NewEncoder(writer).Encode(message)
}

func exitCodeOf(cmd *exec.Cmd, waitErr error) int {
	if cmd.ProcessState != nil {
		return cmd.ProcessState.ExitCode()
	}
	var exitError *exec.ExitError
	if errors.As(waitErr, &exitError) {
		return exitError.ExitCode()
	}
	if waitErr != nil {
		return 1
	}
	return 0
}
