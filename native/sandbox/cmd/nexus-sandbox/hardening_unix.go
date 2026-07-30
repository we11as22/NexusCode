//go:build !windows

package main

import "syscall"

func hardenProcess() error {
	// Match the defense-in-depth used by Codex: sandbox brokers must not leave
	// command memory behind in core dumps.
	limit := &syscall.Rlimit{Cur: 0, Max: 0}
	if err := syscall.Setrlimit(syscall.RLIMIT_CORE, limit); err != nil {
		return err
	}
	return hardenPlatformProcess()
}
