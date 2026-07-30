//go:build darwin

package macos

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func macRequest(t *testing.T) protocol.Request {
	t.Helper()
	root := t.TempDir()
	return protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "mac-test",
		Argv:          []string{"/bin/sh", "-lc", "echo ok"},
		Cwd:           root,
		ReadableRoots: []string{"/"},
		WritableRoots: []string{root},
		ReadOnlyRoots: []string{
			filepath.Join(root, ".git"),
			filepath.Join(root, ".nexus"),
			filepath.Join(root, ".agents"),
			filepath.Join(root, ".codex"),
		},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 1_000,
		InheritEnv:    true,
	}
}

func TestBuildSeatbeltCommandUsesHardCodedSystemExecutableAndArgv(t *testing.T) {
	request := macRequest(t)
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	if command.Program != "/usr/bin/sandbox-exec" {
		t.Fatalf("program = %q", command.Program)
	}
	if len(command.Args) < 5 || command.Args[0] != "-p" {
		t.Fatalf("unexpected sandbox argv: %#v", command.Args)
	}
	separator := -1
	for index, arg := range command.Args {
		if arg == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		t.Fatalf("sandbox argv has no -- separator: %#v", command.Args)
	}
	gotCommand := command.Args[separator+1:]
	if strings.Join(gotCommand, "\x00") != strings.Join(request.Argv, "\x00") {
		t.Fatalf("command argv changed: %#v", gotCommand)
	}
}

func TestPolicyIsClosedByDefaultAndProtectsMetadata(t *testing.T) {
	request := macRequest(t)
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	policy := command.Args[1]
	for _, expected := range []string{
		"(deny default)",
		"(allow process-exec)",
		"(allow process-fork)",
		"(allow file-read*",
		"(allow file-write*",
		"(deny file-write*",
		`(literal (param "READONLY_0"))`,
		`(subpath (param "READONLY_0"))`,
		`(literal (param "READONLY_1"))`,
		`(subpath (param "READONLY_1"))`,
	} {
		if !strings.Contains(policy, expected) {
			t.Fatalf("policy missing %q:\n%s", expected, policy)
		}
	}
	if strings.Contains(policy, "(allow network-outbound)") {
		t.Fatalf("restricted policy enables outbound network:\n%s", policy)
	}
}

func TestEnabledNetworkAddsInboundAndOutboundRules(t *testing.T) {
	request := macRequest(t)
	request.Network = protocol.NetworkEnabled
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	policy := command.Args[1]
	if !strings.Contains(policy, "(allow network-outbound)") ||
		!strings.Contains(policy, "(allow network-inbound)") {
		t.Fatalf("enabled network policy is incomplete:\n%s", policy)
	}
}

func TestExplicitUnixSocketAccessEnablesOnlyAFUnixAndScopedPaths(t *testing.T) {
	request := macRequest(t)
	request.AllowUnixSockets = []string{filepath.Join(request.Cwd, "sockets")}
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	policy := command.Args[1]
	for _, expected := range []string{
		"(allow system-socket (socket-domain AF_UNIX))",
		`(allow network-bind (local unix-socket (subpath (param "UNIX_SOCKET_0"))))`,
		`(allow network-outbound (remote unix-socket (subpath (param "UNIX_SOCKET_0"))))`,
	} {
		if !strings.Contains(policy, expected) {
			t.Fatalf("Unix socket policy missing %q:\n%s", expected, policy)
		}
	}
	if strings.Contains(policy, "\n(allow network-outbound)\n") {
		t.Fatalf("Unix socket allowlist unexpectedly enabled general network:\n%s", policy)
	}
}

func TestDefinitionsCarryPathsWithoutPolicyInterpolation(t *testing.T) {
	request := macRequest(t)
	request.WritableRoots = []string{filepath.Join(request.Cwd, `odd " path`)}
	command, err := BuildCommand(request)
	if err != nil {
		t.Fatal(err)
	}
	policy := command.Args[1]
	if strings.Contains(policy, `odd " path`) {
		t.Fatalf("raw path was interpolated into policy:\n%s", policy)
	}
	found := false
	for _, arg := range command.Args {
		if strings.HasPrefix(arg, "-DWRITABLE_0=") {
			found = true
		}
	}
	if !found {
		t.Fatalf("missing writable definition: %#v", command.Args)
	}
}
