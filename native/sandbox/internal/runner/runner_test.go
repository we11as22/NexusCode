package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func TestRunStreamsOutputAndReportsStructuredExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell fixture")
	}
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "run-test",
		Argv:          []string{"/bin/sh", "-c", "printf stdout; printf stderr >&2; exit 7"},
		Cwd:           t.TempDir(),
		ReadableRoots: []string{"/"},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 2_000,
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	var control bytes.Buffer
	result := Run(
		context.Background(),
		request,
		Command{Program: request.Argv[0], Args: request.Argv[1:], Sandbox: "test"},
		&stdout,
		&stderr,
		&control,
	)
	if result.ExitCode != 7 || result.SetupError != nil {
		t.Fatalf("result = %#v", result)
	}
	if stdout.String() != "stdout" || stderr.String() != "stderr" {
		t.Fatalf("streams = %q / %q", stdout.String(), stderr.String())
	}
	var messages []protocol.ControlMessage
	decoder := json.NewDecoder(&control)
	for decoder.More() {
		var message protocol.ControlMessage
		if err := decoder.Decode(&message); err != nil {
			t.Fatal(err)
		}
		messages = append(messages, message)
	}
	if len(messages) != 2 || messages[0].Type != protocol.ControlStarted || messages[1].Type != protocol.ControlExited {
		t.Fatalf("control messages = %#v", messages)
	}
}

func TestRunDoesNotReportStartedWhenNativeSandboxSpawnFails(t *testing.T) {
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "native-spawn-failure",
		Argv:          []string{"ignored"},
		Cwd:           t.TempDir(),
		ReadableRoots: []string{t.TempDir()},
		Network:       protocol.NetworkRestricted,
	}
	// Keep cwd covered while retaining independently hand-built request data.
	request.ReadableRoots = []string{request.Cwd}
	var control bytes.Buffer
	var stderr bytes.Buffer
	result := Run(
		context.Background(),
		request,
		Command{
			Sandbox: "windows-restricted-token",
			Start: func(
				context.Context,
				protocol.Request,
				io.Writer,
				io.Writer,
			) (Process, error) {
				return nil, errors.New("CreateProcessAsUserW denied")
			},
		},
		io.Discard,
		&stderr,
		&control,
	)
	if result.SetupError == nil {
		t.Fatalf("result = %#v", result)
	}
	var message protocol.ControlMessage
	if err := json.NewDecoder(&control).Decode(&message); err != nil {
		t.Fatal(err)
	}
	if message.Type != protocol.ControlError || message.ErrorCode != "spawn_failed" {
		t.Fatalf("control = %#v", message)
	}
	if bytes.Contains(control.Bytes(), []byte(`"type":"started"`)) {
		t.Fatalf("started was emitted before native spawn succeeded: %s", control.Bytes())
	}
	if !strings.Contains(stderr.String(), "CreateProcessAsUserW denied") {
		t.Fatalf("stderr omitted native spawn failure: %q", stderr.String())
	}
}

func TestRunNativeSandboxTimeoutTerminatesWholeProcessBoundary(t *testing.T) {
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "native-timeout",
		Argv:          []string{"ignored"},
		Cwd:           t.TempDir(),
		ReadableRoots: nil,
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 10,
	}
	request.ReadableRoots = []string{request.Cwd}
	process := &fakeProcess{wait: make(chan error)}
	result := Run(
		context.Background(),
		request,
		Command{
			Sandbox: "windows-restricted-token",
			Start: func(
				context.Context,
				protocol.Request,
				io.Writer,
				io.Writer,
			) (Process, error) {
				return process, nil
			},
		},
		io.Discard,
		io.Discard,
		io.Discard,
	)
	if !result.TimedOut || process.terminateCalls != 1 {
		t.Fatalf("result=%#v terminateCalls=%d", result, process.terminateCalls)
	}
}

type fakeProcess struct {
	wait           chan error
	terminateCalls int
}

func (process *fakeProcess) Wait() error {
	return <-process.wait
}

func (process *fakeProcess) Terminate() {
	process.terminateCalls++
	process.wait <- errors.New("terminated")
}

func (process *fakeProcess) Kill() {
	process.wait <- errors.New("killed")
}

func (process *fakeProcess) ExitCode(error) int {
	return 1
}

func TestRunTimeoutTerminatesCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell fixture")
	}
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "timeout-test",
		Argv:          []string{"/bin/sh", "-c", "sleep 30"},
		Cwd:           t.TempDir(),
		ReadableRoots: []string{"/"},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 30,
	}
	started := time.Now()
	result := Run(
		context.Background(),
		request,
		Command{Program: request.Argv[0], Args: request.Argv[1:], Sandbox: "test"},
		&bytes.Buffer{},
		&bytes.Buffer{},
		&bytes.Buffer{},
	)
	if !result.TimedOut {
		t.Fatalf("result = %#v", result)
	}
	if time.Since(started) > 5*time.Second {
		t.Fatalf("timeout took too long: %s", time.Since(started))
	}
}
