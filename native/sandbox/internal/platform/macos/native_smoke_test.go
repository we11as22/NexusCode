//go:build darwin

package macos

import (
	"bytes"
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
)

func runNative(t *testing.T, request protocol.Request) (runner.Result, string, string) {
	t.Helper()
	if os.Getenv("NEXUS_NATIVE_SANDBOX_SMOKE") != "1" {
		t.Skip("set NEXUS_NATIVE_SANDBOX_SMOKE=1 outside an existing sandbox")
	}
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	result := runner.Run(
		context.Background(),
		request,
		runner.Command{Program: command.Program, Args: command.Args, Sandbox: "seatbelt"},
		&stdout,
		&stderr,
		&bytes.Buffer{},
	)
	return result, stdout.String(), stderr.String()
}

func nativeRequest(t *testing.T, workspace string, script string) protocol.Request {
	t.Helper()
	return protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "native-smoke",
		Argv:          []string{"/bin/sh", "-c", script},
		Cwd:           workspace,
		ReadableRoots: []string{"/"},
		WritableRoots: []string{workspace},
		ReadOnlyRoots: []string{
			filepath.Join(workspace, ".git"),
			filepath.Join(workspace, ".nexus"),
			filepath.Join(workspace, ".agents"),
			filepath.Join(workspace, ".codex"),
		},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 5_000,
		InheritEnv:    true,
	}
}

func TestNativeSeatbeltAllowsWorkspaceWrite(t *testing.T) {
	workspace := t.TempDir()
	target := filepath.Join(workspace, "allowed.txt")
	request := nativeRequest(t, workspace, `printf allowed > "$NEXUS_TARGET"`)
	request.Environment = map[string]string{"NEXUS_TARGET": target}
	result, _, stderr := runNative(t, request)
	if result.ExitCode != 0 {
		t.Fatalf("exit=%d setup=%v stderr=%s", result.ExitCode, result.SetupError, stderr)
	}
	content, err := os.ReadFile(target)
	if err != nil || string(content) != "allowed" {
		t.Fatalf("content=%q err=%v", content, err)
	}
}

func TestNativeSeatbeltDeniesOutsideAndProtectedWrites(t *testing.T) {
	workspace := t.TempDir()
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(workspace, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	runtimeRoot := filepath.Join(workspace, "installed-runtime")
	if err := os.Mkdir(runtimeRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name   string
		target string
	}{
		{"outside", filepath.Join(outside, "blocked.txt")},
		{"existing git", filepath.Join(workspace, ".git", "blocked.txt")},
		{"missing nexus", filepath.Join(workspace, ".nexus", "blocked.txt")},
		{"installed runtime", filepath.Join(runtimeRoot, "blocked.txt")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := nativeRequest(t, workspace, `mkdir -p "$(dirname "$NEXUS_TARGET")"; printf blocked > "$NEXUS_TARGET"`)
			request.ReadOnlyRoots = append(request.ReadOnlyRoots, runtimeRoot)
			request.Environment = map[string]string{"NEXUS_TARGET": test.target}
			result, _, stderr := runNative(t, request)
			if result.ExitCode == 0 {
				t.Fatalf("sandbox allowed write to %s", test.target)
			}
			if _, err := os.Stat(test.target); !os.IsNotExist(err) {
				t.Fatalf("blocked target exists or stat failed unexpectedly: %v", err)
			}
			lower := strings.ToLower(stderr)
			if !strings.Contains(lower, "operation not permitted") &&
				!strings.Contains(lower, "permission denied") {
				t.Fatalf("denial not visible in stderr: %q", stderr)
			}
		})
	}
}

func TestNativeSeatbeltPolicyIsInheritedByChildShell(t *testing.T) {
	workspace := t.TempDir()
	outside := filepath.Join(t.TempDir(), "child-blocked.txt")
	request := nativeRequest(t, workspace, `/bin/sh -c 'printf blocked > "$NEXUS_TARGET"'`)
	request.Environment = map[string]string{"NEXUS_TARGET": outside}
	result, _, _ := runNative(t, request)
	if result.ExitCode == 0 {
		t.Fatal("child shell escaped Seatbelt policy")
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("child created outside target: %v", err)
	}
}

func TestNativeSeatbeltRestrictsNetworkByDefault(t *testing.T) {
	if os.Getenv("NEXUS_NATIVE_SANDBOX_SMOKE") != "1" {
		t.Skip("set NEXUS_NATIVE_SANDBOX_SMOKE=1 outside an existing sandbox")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	workspace := t.TempDir()
	request := nativeRequest(
		t,
		workspace,
		`/usr/bin/curl --silent --show-error --max-time 1 "$NEXUS_URL"`,
	)
	request.Environment = map[string]string{
		"NEXUS_URL": "http://" + listener.Addr().String() + "/",
	}
	result, _, _ := runNative(t, request)
	if result.ExitCode == 0 {
		t.Fatal("restricted profile allowed loopback network access")
	}
}

func TestNativeSeatbeltAllowsNetworkOnlyWhenEnabled(t *testing.T) {
	if os.Getenv("NEXUS_NATIVE_SANDBOX_SMOKE") != "1" {
		t.Skip("set NEXUS_NATIVE_SANDBOX_SMOKE=1 outside an existing sandbox")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		accepted <- struct{}{}
		_ = connection.Close()
	}()

	workspace := t.TempDir()
	request := nativeRequest(
		t,
		workspace,
		`/usr/bin/curl --silent --max-time 1 "$NEXUS_URL" >/dev/null`,
	)
	request.Network = protocol.NetworkEnabled
	request.Environment = map[string]string{
		"NEXUS_URL": "http://" + listener.Addr().String() + "/",
	}
	_, _, _ = runNative(t, request)
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("enabled profile did not reach the local listener")
	}
}

func TestNativeSeatbeltAllowsOnlyExplicitUnixSocketPath(t *testing.T) {
	if os.Getenv("NEXUS_NATIVE_SANDBOX_SMOKE") != "1" {
		t.Skip("set NEXUS_NATIVE_SANDBOX_SMOKE=1 outside an existing sandbox")
	}
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("/usr/bin/python3 is unavailable")
	}
	socketDir, err := os.MkdirTemp("/private/tmp", "nxsock-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	socketPath := filepath.Join(socketDir, "allowed.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		accepted <- struct{}{}
		_ = connection.Close()
	}()

	workspace := t.TempDir()
	request := nativeRequest(
		t,
		workspace,
		`/usr/bin/python3 -c 'import os,socket; s=socket.socket(socket.AF_UNIX); s.connect(os.environ["NEXUS_SOCKET"]); s.close()'`,
	)
	request.AllowUnixSockets = []string{socketDir}
	request.Environment = map[string]string{"NEXUS_SOCKET": socketPath}
	result, _, stderr := runNative(t, request)
	if result.ExitCode != 0 {
		t.Fatalf("explicit Unix socket failed: exit=%d stderr=%s", result.ExitCode, stderr)
	}
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("sandboxed process did not reach explicitly allowed Unix socket")
	}
}
