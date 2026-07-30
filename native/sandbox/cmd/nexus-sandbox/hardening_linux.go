//go:build linux

package main

import (
	"fmt"
	"syscall"
)

const (
	prSetDumpable    = 4
	prSetParentDeath = 1
)

func hardenPlatformProcess() error {
	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetDumpable,
		0,
		0,
		0,
		0,
		0,
	); errno != 0 {
		return fmt.Errorf("disable process dumping: %w", errno)
	}
	if _, _, errno := syscall.RawSyscall6(
		syscall.SYS_PRCTL,
		prSetParentDeath,
		uintptr(syscall.SIGTERM),
		0,
		0,
		0,
		0,
	); errno != 0 {
		return fmt.Errorf("set parent-death signal: %w", errno)
	}
	return nil
}
