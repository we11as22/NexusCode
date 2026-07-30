//go:build linux

package main

import (
	"fmt"
	"os"

	"github.com/we11as22/NexusCode/native/sandbox/internal/linuxseccomp"
)

func tryRunPlatformInner() bool {
	if len(os.Args) < 5 || os.Args[1] != "--linux-seccomp-inner" {
		return false
	}
	networkRestricted := os.Args[2] == "restricted"
	if !networkRestricted && os.Args[2] != "enabled" {
		fmt.Fprintln(os.Stderr, "invalid Linux inner network policy")
		os.Exit(125)
	}
	if os.Args[3] != "--" {
		fmt.Fprintln(os.Stderr, "invalid Linux inner command separator")
		os.Exit(125)
	}
	if err := linuxseccomp.ApplyAndExec(os.Args[4:], networkRestricted); err != nil {
		fmt.Fprintf(os.Stderr, "Nexus Linux sandbox hardening failed: %v\n", err)
		os.Exit(125)
	}
	return true
}
