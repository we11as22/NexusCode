//go:build linux

package linux

import (
	"path/filepath"
	"slices"
	"testing"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func linuxRequest(t *testing.T) protocol.Request {
	t.Helper()
	root := t.TempDir()
	return protocol.Request{
		Version:       protocol.ProtocolVersion,
		ExecutionID:   "linux-test",
		Argv:          []string{"/bin/sh", "-lc", "echo ok"},
		Cwd:           root,
		ReadableRoots: []string{"/"},
		WritableRoots: []string{root},
		ReadOnlyRoots: []string{filepath.Join(root, ".git"), filepath.Join(root, ".nexus")},
		Network:       protocol.NetworkRestricted,
		TimeoutMillis: 1_000,
		InheritEnv:    true,
	}
}

func TestBuildCommandUsesBwrapNamespacesAndLayeredMounts(t *testing.T) {
	request := linuxRequest(t)
	command, err := BuildCommand(request, "/trusted/nexus-bwrap", "/trusted/nexus-sandbox")
	if err != nil {
		t.Fatal(err)
	}
	if command.Program != "/trusted/nexus-bwrap" {
		t.Fatalf("program = %q", command.Program)
	}
	for _, expected := range []string{
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--unshare-net",
		"--ro-bind",
		"--bind",
		"--proc",
		"--dev",
		"--chdir",
		"--",
	} {
		if !slices.Contains(command.Args, expected) {
			t.Fatalf("args missing %q: %#v", expected, command.Args)
		}
	}
	if got := command.Args[len(command.Args)-len(request.Argv):]; !slices.Equal(got, request.Argv) {
		t.Fatalf("command argv changed: %#v", got)
	}
	if !slices.Contains(command.Args, "--linux-seccomp-inner") {
		t.Fatalf("inner seccomp stage missing: %#v", command.Args)
	}
}

func TestEnabledNetworkDoesNotUnshareNetworkNamespace(t *testing.T) {
	request := linuxRequest(t)
	request.Network = protocol.NetworkEnabled
	command, err := BuildCommand(request, "/trusted/nexus-bwrap", "/trusted/nexus-sandbox")
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(command.Args, "--unshare-net") {
		t.Fatalf("enabled network unexpectedly unshared: %#v", command.Args)
	}
}

func TestBuildCommandRejectsRelativeOrPATHBwrap(t *testing.T) {
	request := linuxRequest(t)
	for _, executable := range []string{"bwrap", "../bwrap", ""} {
		if _, err := BuildCommand(request, executable, "/trusted/nexus-sandbox"); err == nil {
			t.Fatalf("BuildCommand accepted %q", executable)
		}
	}
}

func TestProtectedRootsAreReboundReadOnlyAfterWritableRoot(t *testing.T) {
	request := linuxRequest(t)
	command, err := BuildCommand(request, "/trusted/nexus-bwrap", "/trusted/nexus-sandbox")
	if err != nil {
		t.Fatal(err)
	}
	writableIndex := indexTriple(command.Args, "--bind", request.WritableRoots[0], request.WritableRoots[0])
	protectedIndex := slices.Index(command.Args, "--tmpfs")
	if writableIndex < 0 || protectedIndex < 0 || protectedIndex <= writableIndex {
		t.Fatalf("mount specificity order is unsafe: %#v", command.Args)
	}
}

func indexTriple(args []string, first, second, third string) int {
	for index := 0; index+2 < len(args); index++ {
		if args[index] == first && args[index+1] == second && args[index+2] == third {
			return index
		}
	}
	return -1
}
