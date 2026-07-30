//go:build darwin

package main

import (
	"fmt"
	"syscall"
)

const ptraceDenyAttach = 31

func hardenPlatformProcess() error {
	_, _, errno := syscall.Syscall6(
		syscall.SYS_PTRACE,
		ptraceDenyAttach,
		0,
		0,
		0,
		0,
		0,
	)
	if errno != 0 {
		return fmt.Errorf("deny debugger attach: %w", errno)
	}
	return nil
}
