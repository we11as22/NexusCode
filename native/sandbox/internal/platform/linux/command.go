package linux

import (
	"errors"
	"os"
	"path/filepath"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

type Command struct {
	Program string
	Args    []string
}

// BuildCommand constructs a bubblewrap invocation without consulting PATH.
// The caller is responsible for resolving a bundled or hard-coded trusted
// executable and for applying seccomp in the native Linux launcher.
func BuildCommand(request protocol.Request, bwrapExecutable, sandboxExecutable string) (Command, error) {
	if err := request.Validate(); err != nil {
		return Command{}, err
	}
	if bwrapExecutable == "" || !filepath.IsAbs(bwrapExecutable) {
		return Command{}, errors.New("bubblewrap executable must be an absolute trusted path")
	}
	if sandboxExecutable == "" || !filepath.IsAbs(sandboxExecutable) {
		return Command{}, errors.New("sandbox executable must be an absolute trusted path")
	}

	args := []string{
		"--die-with-parent",
		"--new-session",
		"--unshare-user",
		"--unshare-pid",
		"--unshare-ipc",
		"--unshare-uts",
		"--uid", "0",
		"--gid", "0",
		"--cap-drop", "ALL",
	}
	if request.Network == protocol.NetworkRestricted {
		args = append(args, "--unshare-net")
	}

	// Start from an immutable view of the host and layer only explicit writes.
	args = append(args, "--ro-bind", "/", "/")
	for _, root := range request.WritableRoots {
		args = append(args, "--bind", root, root)
	}
	// More-specific read-only mounts must follow writable parents.
	for _, root := range request.ReadOnlyRoots {
		if _, err := os.Lstat(root); err == nil {
			args = append(args, "--ro-bind", root, root)
		} else if os.IsNotExist(err) {
			args = append(
				args,
				"--perms", "0555",
				"--tmpfs", root,
				"--remount-ro", root,
			)
		} else {
			return Command{}, err
		}
	}
	for _, root := range request.DeniedRoots {
		args = append(args, "--tmpfs", root)
	}

	args = append(args,
		"--proc", "/proc",
		"--dev", "/dev",
		"--chdir", request.Cwd,
		"--",
	)
	args = append(
		args,
		sandboxExecutable,
		"--linux-seccomp-inner",
		string(request.Network),
		"--",
	)
	args = append(args, request.Argv...)
	return Command{Program: bwrapExecutable, Args: args}, nil
}
