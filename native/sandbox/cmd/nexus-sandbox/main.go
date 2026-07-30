package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	"github.com/we11as22/NexusCode/native/sandbox/internal/app"
	"github.com/we11as22/NexusCode/native/sandbox/internal/platform"
	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
)

var version = "dev"

func main() {
	if err := hardenProcess(); err != nil {
		fmt.Fprintf(os.Stderr, "sandbox process hardening failed: %v\n", err)
		os.Exit(125)
	}
	if tryRunPlatformInner() {
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("nexus-sandbox %s protocol=%d\n", version, protocol.ProtocolVersion)
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "--check" {
		checkBackend()
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "usage: nexus-sandbox [--version|--check]")
		os.Exit(125)
	}

	control := controlWriter()
	ctx, stop := signal.NotifyContext(
		context.Background(),
		terminationSignals()...,
	)
	defer stop()
	exitCode := app.Run(
		ctx,
		os.Stdin,
		os.Stdout,
		os.Stderr,
		control,
		func(request protocol.Request) (runner.Command, error) {
			command, err := platform.BuildCommand(request)
			if err != nil {
				return runner.Command{}, err
			}
			return runner.Command{
				Program: command.Program,
				Args:    command.Args,
				Sandbox: command.Sandbox,
			}, nil
		},
	)
	os.Exit(exitCode)
}

// checkBackend verifies that the current-platform policy builder and its
// trusted runtime dependencies are available without launching an untrusted
// command. Installers and `nexus doctor` use this to avoid treating a
// version-printing but fail-closed helper as operational.
func checkBackend() {
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "sandbox backend unavailable: %v\n", err)
		os.Exit(125)
	}
	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "sandbox backend unavailable: %v\n", err)
		os.Exit(125)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sandbox backend unavailable: %v\n", err)
		os.Exit(125)
	}
	readableRoot := string(filepath.Separator)
	if volume := filepath.VolumeName(cwd); volume != "" {
		readableRoot = volume + string(filepath.Separator)
	}
	request := protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "nexus-sandbox-check",
		Argv:          []string{executable, "--version"},
		Cwd:           cwd,
		ReadableRoots: []string{readableRoot},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 5_000,
		Environment:   map[string]string{},
	}
	command, err := platform.BuildCommand(request)
	if err != nil {
		fmt.Fprintf(os.Stderr, "sandbox backend unavailable: %v\n", err)
		os.Exit(125)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	result := runner.Run(
		context.Background(),
		request,
		runner.Command{
			Program: command.Program,
			Args:    command.Args,
			Sandbox: command.Sandbox,
		},
		&stdout,
		&stderr,
		io.Discard,
	)
	expected := fmt.Sprintf(
		"nexus-sandbox %s protocol=%d",
		version,
		protocol.ProtocolVersion,
	)
	if result.SetupError != nil ||
		result.TimedOut ||
		result.ExitCode != 0 ||
		strings.TrimSpace(stdout.String()) != expected {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" && result.SetupError != nil {
			detail = result.SetupError.Error()
		}
		if detail == "" {
			detail = fmt.Sprintf(
				"probe exit=%d timedOut=%t stdout=%q",
				result.ExitCode,
				result.TimedOut,
				stdout.String(),
			)
		}
		fmt.Fprintf(os.Stderr, "sandbox backend unavailable: %s\n", detail)
		os.Exit(125)
	}
	fmt.Printf("nexus-sandbox backend=%s ready\n", command.Sandbox)
}

func controlWriter() io.Writer {
	file := os.NewFile(uintptr(3), "nexus-sandbox-control")
	if file == nil {
		return io.Discard
	}
	if _, err := file.Stat(); err != nil {
		_ = file.Close()
		return io.Discard
	}
	return file
}
