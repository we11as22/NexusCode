//go:build linux

package platform

import (
	"errors"
	"os"
	"path/filepath"

	linuxsandbox "github.com/we11as22/NexusCode/native/sandbox/internal/platform/linux"
	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

func BuildCommand(request protocol.Request) (Command, error) {
	bwrap, err := resolveBubblewrap()
	if err != nil {
		return Command{}, err
	}
	sandboxExecutable, err := os.Executable()
	if err != nil {
		return Command{}, err
	}
	sandboxExecutable, err = filepath.EvalSymlinks(sandboxExecutable)
	if err != nil {
		return Command{}, err
	}
	command, err := linuxsandbox.BuildCommand(request, bwrap, sandboxExecutable)
	if err != nil {
		return Command{}, err
	}
	return Command{Program: command.Program, Args: command.Args, Sandbox: "bwrap-seccomp"}, nil
}

func resolveBubblewrap() (string, error) {
	executable, err := os.Executable()
	if err == nil {
		candidate := filepath.Join(filepath.Dir(executable), "nexus-bwrap")
		if trustedExecutable(candidate) {
			return candidate, nil
		}
	}
	for _, candidate := range []string{"/usr/bin/bwrap", "/usr/local/bin/bwrap"} {
		if trustedExecutable(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("trusted bubblewrap runtime is unavailable")
}

func trustedExecutable(candidate string) bool {
	info, err := os.Stat(candidate)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}
