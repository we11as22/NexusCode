//go:build linux

package linuxseccomp

import (
	"errors"
	"fmt"
	"os"
	"runtime"
	"syscall"
	"unsafe"
)

const (
	prSetNoNewPrivs   = 38
	prSetSeccomp      = 22
	seccompModeFilter = 2

	bpfLD  = 0x00
	bpfW   = 0x00
	bpfABS = 0x20
	bpfJMP = 0x05
	bpfJEQ = 0x10
	bpfK   = 0x00
	bpfRET = 0x06

	seccompRetKillProcess = 0x80000000
	seccompRetErrno       = 0x00050000
	seccompRetAllow       = 0x7fff0000

	seccompDataNrOffset   = 0
	seccompDataArchOffset = 4
	seccompDataArg0Offset = 16
	afUnix                = 1
	eperm                 = 1
)

type sockFilter struct {
	Code uint16
	Jt   uint8
	Jf   uint8
	K    uint32
}

type sockFprog struct {
	Len    uint16
	Filter *sockFilter
}

func statement(code uint16, value uint32) sockFilter {
	return sockFilter{Code: code, K: value}
}

func jump(code uint16, value uint32, jt, jf uint8) sockFilter {
	return sockFilter{Code: code, K: value, Jt: jt, Jf: jf}
}

// ApplyAndExec mirrors Codex's inner Linux stage: bubblewrap establishes the
// mount/network namespaces first, then this process sets no_new_privs,
// installs the seccomp hardening filter, and execs the user command.
func ApplyAndExec(argv []string, networkRestricted bool) error {
	if len(argv) == 0 {
		return errors.New("Linux sandbox inner command is empty")
	}
	runtime.LockOSThread()
	if err := install(networkRestricted); err != nil {
		return err
	}
	return syscall.Exec(argv[0], argv, os.Environ())
}

func install(networkRestricted bool) error {
	filters := []sockFilter{
		statement(bpfLD|bpfW|bpfABS, seccompDataArchOffset),
		jump(bpfJMP|bpfJEQ|bpfK, auditArchitecture, 1, 0),
		statement(bpfRET|bpfK, seccompRetKillProcess),
		statement(bpfLD|bpfW|bpfABS, seccompDataNrOffset),
	}
	for _, number := range alwaysDeniedSyscalls {
		filters = append(filters,
			jump(bpfJMP|bpfJEQ|bpfK, number, 0, 1),
			statement(bpfRET|bpfK, seccompRetErrno|eperm),
		)
	}
	if networkRestricted {
		for _, number := range networkDeniedSyscalls {
			filters = append(filters,
				jump(bpfJMP|bpfJEQ|bpfK, number, 0, 1),
				statement(bpfRET|bpfK, seccompRetErrno|eperm),
			)
		}
		for _, number := range []uint32{sysSocket, sysSocketpair} {
			filters = append(filters,
				// Non-matching syscalls skip the arg load, comparison, and deny.
				jump(bpfJMP|bpfJEQ|bpfK, number, 0, 3),
				statement(bpfLD|bpfW|bpfABS, seccompDataArg0Offset),
				// AF_UNIX skips the deny instruction.
				jump(bpfJMP|bpfJEQ|bpfK, afUnix, 1, 0),
				statement(bpfRET|bpfK, seccompRetErrno|eperm),
			)
		}
	}
	filters = append(filters, statement(bpfRET|bpfK, seccompRetAllow))
	if len(filters) > int(^uint16(0)) {
		return errors.New("seccomp program is too large")
	}

	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetNoNewPrivs,
		1,
		0,
		0,
		0,
		0,
	); errno != 0 {
		return fmt.Errorf("set no_new_privs: %w", errno)
	}
	program := sockFprog{
		Len:    uint16(len(filters)),
		Filter: &filters[0],
	}
	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetSeccomp,
		seccompModeFilter,
		uintptr(unsafe.Pointer(&program)),
		0,
		0,
		0,
	); errno != 0 {
		return fmt.Errorf("install seccomp filter: %w", errno)
	}
	return nil
}
