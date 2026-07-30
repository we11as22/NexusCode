package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"testing"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
)

func TestRunRejectsOversizedOrMalformedInputWithoutSpawning(t *testing.T) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	var control bytes.Buffer
	exitCode := Run(
		context.Background(),
		bytes.NewBufferString(`{"version":1,"disableSandbox":true}`),
		&stdout,
		&stderr,
		&control,
		func(protocol.Request) (runner.Command, error) {
			t.Fatal("builder called for invalid input")
			return runner.Command{}, nil
		},
	)
	if exitCode == 0 {
		t.Fatal("invalid request succeeded")
	}
	var message protocol.ControlMessage
	if err := json.NewDecoder(&control).Decode(&message); err != nil {
		t.Fatal(err)
	}
	if message.Type != protocol.ControlError || message.ErrorCode != "invalid_request" {
		t.Fatalf("message = %#v", message)
	}
}

func TestRunMirrorsSetupFailureToStderrWhenControlTransportIsUnavailable(t *testing.T) {
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "setup-diagnostic",
		Argv:          []string{"ignored"},
		Cwd:           t.TempDir(),
		ReadableRoots: []string{t.TempDir()},
		Network:       protocol.NetworkRestricted,
	}
	request.ReadableRoots = []string{request.Cwd}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	exitCode := Run(
		context.Background(),
		bytes.NewReader(encoded),
		&bytes.Buffer{},
		&stderr,
		nil,
		func(protocol.Request) (runner.Command, error) {
			return runner.Command{}, errors.New("native authority unavailable")
		},
	)
	if exitCode != 125 {
		t.Fatalf("exit = %d", exitCode)
	}
	if got := stderr.String(); got != "nexus-sandbox: native authority unavailable\n" {
		t.Fatalf("stderr = %q", got)
	}
}

func TestRunExecutesOnlyTheBuilderCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell fixture")
	}
	root := t.TempDir()
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "app-test",
		Argv:          []string{"/bin/sh", "-c", "exit 99"},
		Cwd:           root,
		ReadableRoots: []string{"/"},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 1_000,
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	var control bytes.Buffer
	exitCode := Run(
		context.Background(),
		bytes.NewReader(encoded),
		&stdout,
		&stderr,
		&control,
		func(got protocol.Request) (runner.Command, error) {
			if got.ExecutionID != request.ExecutionID {
				t.Fatalf("request changed: %#v", got)
			}
			return runner.Command{
				Program: "/bin/sh",
				Args:    []string{"-c", "printf brokered"},
				Sandbox: "test",
			}, nil
		},
	)
	if exitCode != 0 || stdout.String() != "brokered" {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
}
