//go:build windows

package main

import (
	"fmt"
	"syscall"
)

const (
	semFailCriticalErrors     = 0x0001
	semNoGPFaultErrorBox      = 0x0002
	semNoOpenFileErrorBox     = 0x8000
	loadLibrarySearchSystem32 = 0x00000800
)

func hardenProcess() error {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	setErrorMode := kernel32.NewProc("SetErrorMode")
	setDefaultDLLDirectories := kernel32.NewProc("SetDefaultDllDirectories")
	setErrorMode.Call(
		semFailCriticalErrors |
			semNoGPFaultErrorBox |
			semNoOpenFileErrorBox,
	)
	result, _, callErr := setDefaultDLLDirectories.Call(loadLibrarySearchSystem32)
	if result == 0 {
		return fmt.Errorf("SetDefaultDllDirectories failed: %w", callErr)
	}
	return nil
}
