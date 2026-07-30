package macos

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
)

const seatbeltExecutable = "/usr/bin/sandbox-exec"

// seatbeltBasePolicy is adapted from OpenAI Codex's Apache-2.0 Seatbelt base
// policy (source_projects/codex/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl).
// Nexus owns this copy and its protocol; no Codex executable or package is used.
const seatbeltBasePolicy = `(version 1)

(deny default)

; Children inherit the policy.
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))

; Standard process/runtime facilities required by developer tools.
(allow file-write-data
  (require-all
    (path "/dev/null")
    (vnode-type CHARACTER-DEVICE)))
(allow sysctl-read
  (sysctl-name "hw.activecpu")
  (sysctl-name "hw.busfrequency_compat")
  (sysctl-name "hw.byteorder")
  (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat")
  (sysctl-name "hw.cpufamily")
  (sysctl-name "hw.cpufrequency_compat")
  (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat")
  (sysctl-name "hw.l1icachesize_compat")
  (sysctl-name "hw.l2cachesize_compat")
  (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max")
  (sysctl-name "hw.machine")
  (sysctl-name "hw.model")
  (sysctl-name "hw.memsize")
  (sysctl-name "hw.ncpu")
  (sysctl-name "hw.nperflevels")
  (sysctl-name-prefix "hw.optional.arm.")
  (sysctl-name-prefix "hw.optional.armv8_")
  (sysctl-name "hw.packages")
  (sysctl-name "hw.pagesize_compat")
  (sysctl-name "hw.pagesize")
  (sysctl-name "hw.physicalcpu")
  (sysctl-name "hw.physicalcpu_max")
  (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.cpufrequency")
  (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit")
  (sysctl-name "machdep.cpu.brand_string")
  (sysctl-name "kern.argmax")
  (sysctl-name "kern.hostname")
  (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.maxproc")
  (sysctl-name "kern.osproductversion")
  (sysctl-name "kern.osrelease")
  (sysctl-name "kern.ostype")
  (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion")
  (sysctl-name "kern.secure_kernel")
  (sysctl-name "kern.usrstack64")
  (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype")
  (sysctl-name "vm.loadavg")
  (sysctl-name-prefix "hw.perflevel")
  (sysctl-name-prefix "kern.proc.pgrp.")
  (sysctl-name-prefix "kern.proc.pid.")
  (sysctl-name-prefix "net.routetable."))
(allow sysctl-write (sysctl-name "kern.grade_cputype"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow mach-lookup
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.cfprefsd.daemon")
  (global-name "com.apple.cfprefsd.agent")
  (local-name "com.apple.cfprefsd.agent"))
(allow ipc-posix-sem)
(allow ipc-posix-shm-read-data
  ipc-posix-shm-write-create
  ipc-posix-shm-write-unlink
  (ipc-posix-name-regex #"^/__KMP_REGISTERED_LIB_[0-9]+$"))
(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))
(allow user-preference-read)

; Interactive and captured command execution.
(allow pseudo-tty)
(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))
(allow file-read* file-write*
  (require-all
    (regex #"^/dev/ttys[0-9]+")
    (extension "com.apple.sandbox.pty")))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+"))
`

type Command struct {
	Program string
	Args    []string
}

func BuildCommand(request protocol.Request) (Command, error) {
	if err := request.Validate(); err != nil {
		return Command{}, err
	}

	policy := seatbeltBasePolicy
	args := make([]string, 0, 3+
		len(request.ReadableRoots)+
		len(request.WritableRoots)+
		len(request.ReadOnlyRoots)+
		len(request.DeniedRoots)+
		len(request.AllowUnixSockets)+
		len(request.Argv))

	policy += "\n; readable roots\n(allow file-read* file-test-existence\n"
	for index, root := range request.ReadableRoots {
		root, err := canonicalizeForSandbox(root)
		if err != nil {
			return Command{}, err
		}
		key := fmt.Sprintf("READABLE_%d", index)
		policy += fmt.Sprintf("  (subpath (param %q))\n", key)
		args = append(args, fmt.Sprintf("-D%s=%s", key, root))
	}
	policy += ")\n"

	if len(request.WritableRoots) > 0 {
		policy += "\n; writable roots\n(allow file-write*\n"
		for index, root := range request.WritableRoots {
			root, err := canonicalizeForSandbox(root)
			if err != nil {
				return Command{}, err
			}
			key := fmt.Sprintf("WRITABLE_%d", index)
			policy += fmt.Sprintf("  (subpath (param %q))\n", key)
			args = append(args, fmt.Sprintf("-D%s=%s", key, root))
		}
		policy += ")\n"
	}

	if len(request.ReadOnlyRoots) > 0 {
		policy += "\n; protected read-only roots, exact path and descendants\n(deny file-write*\n"
		for index, root := range request.ReadOnlyRoots {
			root, err := canonicalizeForSandbox(root)
			if err != nil {
				return Command{}, err
			}
			key := fmt.Sprintf("READONLY_%d", index)
			policy += fmt.Sprintf(
				"  (literal (param %q))\n  (subpath (param %q))\n",
				key,
				key,
			)
			args = append(args, fmt.Sprintf("-D%s=%s", key, root))
		}
		policy += ")\n"
	}

	if len(request.DeniedRoots) > 0 {
		policy += "\n; unreadable roots\n(deny file-read* file-write*\n"
		for index, root := range request.DeniedRoots {
			root, err := canonicalizeForSandbox(root)
			if err != nil {
				return Command{}, err
			}
			key := fmt.Sprintf("DENIED_%d", index)
			policy += fmt.Sprintf(
				"  (literal (param %q))\n  (subpath (param %q))\n",
				key,
				key,
			)
			args = append(args, fmt.Sprintf("-D%s=%s", key, root))
		}
		policy += ")\n"
	}

	if len(request.AllowUnixSockets) > 0 {
		policy += "\n; explicitly allowed Unix sockets\n"
		policy += "(allow system-socket (socket-domain AF_UNIX))\n"
		for index, root := range request.AllowUnixSockets {
			root, err := canonicalizeForSandbox(root)
			if err != nil {
				return Command{}, err
			}
			key := fmt.Sprintf("UNIX_SOCKET_%d", index)
			policy += fmt.Sprintf(
				"(allow network-bind (local unix-socket (subpath (param %q))))\n"+
					"(allow network-outbound (remote unix-socket (subpath (param %q))))\n",
				key,
				key,
			)
			args = append(args, fmt.Sprintf("-D%s=%s", key, root))
		}
	}

	if request.Network == protocol.NetworkEnabled {
		policy += "\n(allow network-outbound)\n(allow network-inbound)\n"
	}

	fullArgs := []string{"-p", policy}
	fullArgs = append(fullArgs, args...)
	fullArgs = append(fullArgs, "--")
	fullArgs = append(fullArgs, request.Argv...)
	return Command{Program: seatbeltExecutable, Args: fullArgs}, nil
}

// canonicalizeForSandbox resolves every existing path component while
// preserving a not-yet-created suffix. This closes the /var -> /private/var
// alias and symlink escape class without requiring protected paths to exist.
func canonicalizeForSandbox(candidate string) (string, error) {
	candidate = filepath.Clean(candidate)
	current := candidate
	missing := make([]string, 0, 4)
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("canonicalize sandbox path %q: %w", candidate, err)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("canonicalize sandbox path %q: no existing ancestor", candidate)
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}
