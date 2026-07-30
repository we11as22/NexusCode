//go:build !windows

package windowsnative

import (
	"context"
	"errors"
	"io"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

var errWindowsOnly = errors.New("Windows sandbox backend is only available on Windows")

func RequireReady() error {
	return errWindowsOnly
}

func Status() windowsmodel.SetupStatus {
	return windowsmodel.SetupStatus{
		State:  windowsmodel.SetupMissing,
		Detail: errWindowsOnly.Error(),
	}
}

func Setup() error {
	return errWindowsOnly
}

func SetupElevated() error {
	return errWindowsOnly
}

func Start(
	context.Context,
	protocol.Request,
	io.Writer,
	io.Writer,
) (runner.Process, error) {
	return nil, errWindowsOnly
}
