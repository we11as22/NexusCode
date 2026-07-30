//go:build windows

package windowsnative

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/runner"
)

const (
	runnerStartupTimeout = 15 * time.Second
	maxSpoolBytes        = 64 << 20
)

type runnerEnvelope struct {
	Version         int              `json:"version"`
	Request         protocol.Request `json:"request"`
	RestrictingSIDs []string         `json:"restrictingSids"`
	ExpectedUserSID string           `json:"expectedUserSid"`
	SandboxGroupSID string           `json:"sandboxGroupSid"`
	StatusPath      string           `json:"statusPath"`
	StdoutPath      string           `json:"stdoutPath"`
	StderrPath      string           `json:"stderrPath"`
}

type runnerStatus struct {
	State   string `json:"state"`
	Message string `json:"message,omitempty"`
}

func Start(
	ctx context.Context,
	request protocol.Request,
	stdout io.Writer,
	stderr io.Writer,
) (runner.Process, error) {
	if err := RequireReady(); err != nil {
		return nil, err
	}
	authority, err := prepareAuthority(request)
	if err != nil {
		return nil, fmt.Errorf("prepare Windows filesystem authority: %w", err)
	}
	secret, err := loadCredentials()
	if err != nil {
		return nil, err
	}
	username := offlineUsername
	password := secret.OfflinePassword
	expectedSID := authority.OfflineSID
	if request.Network == protocol.NetworkEnabled {
		username = onlineUsername
		password = secret.OnlinePassword
		expectedSID = authority.OnlineSID
	}

	runDir, err := createPrivateRunDirectory(expectedSID)
	if err != nil {
		return nil, fmt.Errorf("create Windows sandbox run directory: %w", err)
	}
	cleanupOnError := true
	defer func() {
		if cleanupOnError {
			_ = os.RemoveAll(runDir)
		}
	}()
	envelopePath := filepath.Join(runDir, "request.json")
	statusPath := filepath.Join(runDir, "status.json")
	stdoutPath := filepath.Join(runDir, "stdout.log")
	stderrPath := filepath.Join(runDir, "stderr.log")
	for _, path := range []string{stdoutPath, stderrPath} {
		if err := os.WriteFile(path, nil, 0o600); err != nil {
			return nil, err
		}
	}
	envelope := runnerEnvelope{
		Version:         protocol.ProtocolVersion,
		Request:         request,
		RestrictingSIDs: authority.RestrictingSIDs,
		ExpectedUserSID: expectedSID,
		SandboxGroupSID: authority.GroupSID,
		StatusPath:      statusPath,
		StdoutPath:      stdoutPath,
		StderrPath:      stderrPath,
	}
	data, err := json.Marshal(envelope)
	if err != nil {
		return nil, err
	}
	if err := writeFileAtomic(envelopePath, data, 0o600); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return nil, err
	}
	runnerJob, err := createKillOnCloseJob()
	if err != nil {
		return nil, err
	}
	processInfo, err := createProcessWithLogon(
		username,
		password,
		[]string{executable, "--windows-command-runner", envelopePath},
		request.Cwd,
		runnerJob,
	)
	clearString(&password)
	secret.OfflinePassword = ""
	secret.OnlinePassword = ""
	if err != nil {
		_ = syscall.CloseHandle(runnerJob)
		return nil, err
	}
	_ = syscall.CloseHandle(processInfo.Thread)

	deadline := time.Now().Add(runnerStartupTimeout)
	for {
		status, statusErr := readRunnerStatus(statusPath)
		if statusErr == nil {
			switch status.State {
			case "started":
				process := newBrokerProcess(
					processInfo.Process,
					runnerJob,
					runDir,
					stdoutPath,
					stderrPath,
					stdout,
					stderr,
				)
				_ = os.Remove(statusPath)
				cleanupOnError = false
				return process, nil
			case "error":
				_, _ = syscall.WaitForSingleObject(processInfo.Process, 5_000)
				_ = syscall.CloseHandle(processInfo.Process)
				_ = syscall.CloseHandle(runnerJob)
				return nil, errors.New(status.Message)
			default:
				_ = terminateJob(runnerJob, 125)
				_ = syscall.CloseHandle(processInfo.Process)
				_ = syscall.CloseHandle(runnerJob)
				return nil, fmt.Errorf("invalid Windows runner state %q", status.State)
			}
		}
		if !errors.Is(statusErr, os.ErrNotExist) {
			_ = terminateJob(runnerJob, 125)
			_ = syscall.CloseHandle(processInfo.Process)
			_ = syscall.CloseHandle(runnerJob)
			return nil, fmt.Errorf("read Windows runner status: %w", statusErr)
		}
		if event, waitErr := syscall.WaitForSingleObject(processInfo.Process, 0); waitErr != nil {
			_ = terminateJob(runnerJob, 125)
			_ = syscall.CloseHandle(processInfo.Process)
			_ = syscall.CloseHandle(runnerJob)
			return nil, fmt.Errorf("probe Windows runner startup: %w", waitErr)
		} else if event == waitObject0 {
			var exitCode uint32
			_ = syscall.GetExitCodeProcess(processInfo.Process, &exitCode)
			_ = syscall.CloseHandle(processInfo.Process)
			_ = syscall.CloseHandle(runnerJob)
			return nil, fmt.Errorf(
				"Windows sandbox runner exited before restricted spawn (exit=%d)",
				exitCode,
			)
		}
		select {
		case <-ctx.Done():
			_ = terminateJob(runnerJob, 125)
			_ = syscall.CloseHandle(processInfo.Process)
			_ = syscall.CloseHandle(runnerJob)
			return nil, ctx.Err()
		default:
		}
		if time.Now().After(deadline) {
			_ = terminateJob(runnerJob, 125)
			_ = syscall.CloseHandle(processInfo.Process)
			_ = syscall.CloseHandle(runnerJob)
			return nil, errors.New("Windows sandbox runner did not confirm restricted spawn")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func RunCommandRunner(envelopePath string) int {
	envelope, err := readRunnerEnvelope(envelopePath)
	if err != nil {
		return 125
	}
	fail := func(err error) int {
		_ = writeRunnerJSON(envelope.StatusPath, runnerStatus{
			State: "error", Message: err.Error(),
		})
		return 125
	}
	if envelope.Version != protocol.ProtocolVersion {
		return fail(fmt.Errorf("unsupported Windows runner protocol %d", envelope.Version))
	}
	if err := envelope.Request.Validate(); err != nil {
		return fail(err)
	}
	if envelope.ExpectedUserSID == "" || envelope.SandboxGroupSID == "" {
		return fail(errors.New("Windows runner identity authority is incomplete"))
	}
	current, err := syscall.OpenCurrentProcessToken()
	if err != nil {
		return fail(err)
	}
	user, err := current.GetTokenUser()
	current.Close()
	if err != nil {
		return fail(err)
	}
	actualSID, err := user.User.Sid.String()
	if err != nil {
		return fail(err)
	}
	if !strings.EqualFold(actualSID, envelope.ExpectedUserSID) {
		return fail(fmt.Errorf(
			"Windows runner identity mismatch: got %s, expected %s",
			actualSID,
			envelope.ExpectedUserSID,
		))
	}
	// The request carries authority material. Remove its only filesystem copy
	// before any untrusted child can start.
	if err := os.Remove(envelopePath); err != nil {
		return fail(fmt.Errorf("remove consumed Windows runner request: %w", err))
	}

	token, err := createRestrictedPrimaryToken(
		envelope.RestrictingSIDs,
		envelope.ExpectedUserSID,
	)
	if err != nil {
		return fail(err)
	}
	defer token.Close()
	job, err := createKillOnCloseJob()
	if err != nil {
		return fail(err)
	}
	defer syscall.CloseHandle(job)

	stdin, err := os.OpenFile("NUL", os.O_RDONLY, 0)
	if err != nil {
		return fail(err)
	}
	defer stdin.Close()
	stdout, err := os.OpenFile(envelope.StdoutPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return fail(err)
	}
	defer stdout.Close()
	stderr, err := os.OpenFile(envelope.StderrPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return fail(err)
	}
	defer stderr.Close()
	desktop, err := createPrivateDesktop()
	if err != nil {
		return fail(err)
	}
	defer desktop.Close()

	argv := append([]string(nil), envelope.Request.Argv...)
	program, err := resolveWindowsProgram(argv[0], buildRequestEnvironment(envelope.Request))
	if err != nil {
		return fail(err)
	}
	argv[0] = program
	processInfo, err := createRestrictedProcess(
		token,
		argv,
		envelope.Request.Cwd,
		buildRequestEnvironment(envelope.Request),
		syscall.Handle(stdin.Fd()),
		syscall.Handle(stdout.Fd()),
		syscall.Handle(stderr.Fd()),
		job,
		desktop.name,
	)
	if err != nil {
		return fail(err)
	}
	_ = syscall.CloseHandle(processInfo.Thread)
	defer syscall.CloseHandle(processInfo.Process)
	if err := writeRunnerJSON(envelope.StatusPath, runnerStatus{State: "started"}); err != nil {
		_ = terminateJob(job, 125)
		return fail(err)
	}
	event, err := syscall.WaitForSingleObject(processInfo.Process, infinite)
	if err != nil || event != waitObject0 {
		_ = terminateJob(job, 125)
		return fail(fmt.Errorf("wait for restricted process failed: event=%d err=%w", event, err))
	}
	var exitCode uint32
	if err := syscall.GetExitCodeProcess(processInfo.Process, &exitCode); err != nil {
		return fail(err)
	}
	return int(exitCode)
}

type brokerProcess struct {
	handle    syscall.Handle
	job       syscall.Handle
	runDir    string
	done      chan struct{}
	tailers   sync.WaitGroup
	closeOnce sync.Once
	exitCode  int
}

func newBrokerProcess(
	handle syscall.Handle,
	job syscall.Handle,
	runDir string,
	stdoutPath string,
	stderrPath string,
	stdout io.Writer,
	stderr io.Writer,
) *brokerProcess {
	process := &brokerProcess{
		handle:   handle,
		job:      job,
		runDir:   runDir,
		done:     make(chan struct{}),
		exitCode: 1,
	}
	process.tailers.Add(2)
	go process.tail(stdoutPath, stdout)
	go process.tail(stderrPath, stderr)
	return process
}

func (process *brokerProcess) Wait() error {
	event, waitErr := syscall.WaitForSingleObject(process.handle, infinite)
	close(process.done)
	process.tailers.Wait()
	var exitCode uint32
	exitErr := syscall.GetExitCodeProcess(process.handle, &exitCode)
	process.exitCode = int(exitCode)
	process.close()
	if waitErr != nil || event != waitObject0 {
		return fmt.Errorf("wait for Windows sandbox runner failed: event=%d err=%w", event, waitErr)
	}
	if exitErr != nil {
		return fmt.Errorf("read Windows sandbox runner exit code: %w", exitErr)
	}
	if process.exitCode != 0 {
		return &runnerExitError{code: process.exitCode}
	}
	return nil
}

func (process *brokerProcess) Terminate() {
	_ = terminateJob(process.job, 124)
}

func (process *brokerProcess) Kill() {
	_ = terminateJob(process.job, 137)
}

func (process *brokerProcess) ExitCode(error) int {
	return process.exitCode
}

func (process *brokerProcess) close() {
	process.closeOnce.Do(func() {
		_ = syscall.CloseHandle(process.handle)
		_ = syscall.CloseHandle(process.job)
		_ = os.RemoveAll(process.runDir)
	})
}

func (process *brokerProcess) tail(path string, destination io.Writer) {
	defer process.tailers.Done()
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()
	buffer := make([]byte, 32*1024)
	var total int64
	forward := func(chunk []byte) bool {
		remaining := int64(maxSpoolBytes) - total
		if remaining <= 0 {
			_ = terminateJob(process.job, 125)
			return false
		}
		exceeded := int64(len(chunk)) > remaining
		if exceeded {
			chunk = chunk[:remaining]
		}
		if len(chunk) > 0 {
			total += int64(len(chunk))
			_, _ = destination.Write(chunk)
		}
		if exceeded {
			_ = terminateJob(process.job, 125)
			return false
		}
		return true
	}
	for {
		count, readErr := file.Read(buffer)
		if count > 0 && !forward(buffer[:count]) {
			return
		}
		if readErr == nil {
			continue
		}
		if !errors.Is(readErr, io.EOF) {
			return
		}
		select {
		case <-process.done:
			// Drain every byte flushed between the last EOF and runner exit.
			for {
				count, readErr = file.Read(buffer)
				if count > 0 && !forward(buffer[:count]) {
					return
				}
				if readErr != nil {
					return
				}
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
}

type runnerExitError struct {
	code int
}

func (err *runnerExitError) Error() string {
	return fmt.Sprintf("restricted process exited with code %d", err.code)
}

func readRunnerEnvelope(path string) (runnerEnvelope, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return runnerEnvelope{}, err
	}
	var envelope runnerEnvelope
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return runnerEnvelope{}, err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return runnerEnvelope{}, errors.New("Windows runner request contains trailing JSON")
		}
		return runnerEnvelope{}, err
	}
	return envelope, nil
}

func readRunnerStatus(path string) (runnerStatus, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return runnerStatus{}, err
	}
	var status runnerStatus
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return runnerStatus{}, err
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return runnerStatus{}, errors.New("Windows runner status contains trailing JSON")
		}
		return runnerStatus{}, err
	}
	return status, nil
}

func writeRunnerJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return writeFileAtomic(path, data, 0o600)
}

func buildRequestEnvironment(request protocol.Request) []string {
	values := make(map[string]string)
	if request.InheritEnv {
		for _, entry := range os.Environ() {
			if index := strings.IndexByte(entry, '='); index > 0 {
				values[strings.ToUpper(entry[:index])] = entry
			}
		}
	}
	for key, value := range request.Environment {
		values[strings.ToUpper(key)] = key + "=" + value
	}
	result := make([]string, 0, len(values))
	for _, entry := range values {
		result = append(result, entry)
	}
	return result
}

func resolveWindowsProgram(program string, environment []string) (string, error) {
	if filepath.IsAbs(program) {
		info, err := os.Stat(program)
		if err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("sandbox executable is unavailable: %s", program)
		}
		return program, nil
	}
	pathValue := ""
	for _, entry := range environment {
		if strings.HasPrefix(strings.ToUpper(entry), "PATH=") {
			pathValue = entry[len("PATH="):]
			break
		}
	}
	originalPath := os.Getenv("PATH")
	if pathValue != "" {
		_ = os.Setenv("PATH", pathValue)
		defer os.Setenv("PATH", originalPath)
	}
	resolved, err := exec.LookPath(program)
	if err != nil {
		return "", err
	}
	return filepath.Abs(resolved)
}

func clearString(value *string) {
	if value != nil {
		*value = ""
	}
}
