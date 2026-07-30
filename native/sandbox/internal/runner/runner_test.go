package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"runtime"
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
