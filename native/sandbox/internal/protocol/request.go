package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

const ProtocolVersion = 1

const (
	MaxRequestBytes    = 1 << 20
	MaxRoots           = 512
	MaxEnvironmentVars = 4096
	MaxArgvItems       = 4096
	MaxTimeoutMillis   = 24 * 60 * 60 * 1000
)

type NetworkPolicy string

const (
	NetworkRestricted NetworkPolicy = "restricted"
	NetworkEnabled    NetworkPolicy = "enabled"
)

type Request struct {
	Version          int               `json:"version"`
	ExecutionID      string            `json:"executionId"`
	Argv             []string          `json:"argv"`
	Cwd              string            `json:"cwd"`
	ReadableRoots    []string          `json:"readableRoots"`
	WritableRoots    []string          `json:"writableRoots"`
	ReadOnlyRoots    []string          `json:"readOnlyRoots"`
	DeniedRoots      []string          `json:"deniedRoots,omitempty"`
	Network          NetworkPolicy     `json:"network"`
	TimeoutMillis    int64             `json:"timeoutMillis"`
	InheritEnv       bool              `json:"inheritEnv"`
	Environment      map[string]string `json:"environment,omitempty"`
	AllowUnixSockets []string          `json:"allowUnixSockets,omitempty"`
}

type ControlType string

const (
	ControlStarted ControlType = "started"
	ControlExited  ControlType = "exited"
	ControlError   ControlType = "error"
)

type ControlMessage struct {
	Version     int         `json:"version"`
	Type        ControlType `json:"type"`
	ExecutionID string      `json:"executionId"`
	Sandbox     string      `json:"sandbox,omitempty"`
	ExitCode    *int        `json:"exitCode,omitempty"`
	ErrorCode   string      `json:"errorCode,omitempty"`
	Message     string      `json:"message,omitempty"`
	TimedOut    bool        `json:"timedOut,omitempty"`

	// Command streams are deliberately never serialized into the control
	// protocol. These fields remain excluded so accidental assignment is visible
	// to tests without changing the wire format.
	Stdout string `json:"-"`
	Stderr string `json:"-"`
}

func DecodeRequest(data []byte) (Request, error) {
	if len(data) == 0 {
		return Request{}, errors.New("sandbox request is empty")
	}
	if len(data) > MaxRequestBytes {
		return Request{}, fmt.Errorf("sandbox request exceeds %d bytes", MaxRequestBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request Request
	if err := decoder.Decode(&request); err != nil {
		return Request{}, fmt.Errorf("decode sandbox request: %w", err)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Request{}, errors.New("sandbox request contains trailing JSON values")
		}
		return Request{}, fmt.Errorf("decode trailing sandbox request data: %w", err)
	}
	if err := request.Validate(); err != nil {
		return Request{}, err
	}
	return request, nil
}

func (r Request) Validate() error {
	if r.Version != ProtocolVersion {
		return fmt.Errorf("unsupported sandbox protocol version %d", r.Version)
	}
	if strings.TrimSpace(r.ExecutionID) == "" || len(r.ExecutionID) > 256 {
		return errors.New("executionId must be non-empty and at most 256 bytes")
	}
	if len(r.Argv) == 0 || len(r.Argv) > MaxArgvItems {
		return fmt.Errorf("argv must contain 1..%d items", MaxArgvItems)
	}
	for index, arg := range r.Argv {
		if strings.IndexByte(arg, 0) >= 0 {
			return fmt.Errorf("argv[%d] contains NUL", index)
		}
	}
	if err := validateAbsolutePath("cwd", r.Cwd); err != nil {
		return err
	}
	if r.Network != NetworkRestricted && r.Network != NetworkEnabled {
		return fmt.Errorf("invalid network policy %q", r.Network)
	}
	if r.TimeoutMillis < 0 || r.TimeoutMillis > MaxTimeoutMillis {
		return fmt.Errorf("timeoutMillis must be between 0 and %d", MaxTimeoutMillis)
	}
	if len(r.Environment) > MaxEnvironmentVars {
		return fmt.Errorf("environment exceeds %d variables", MaxEnvironmentVars)
	}
	for key, value := range r.Environment {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.IndexByte(value, 0) >= 0 {
			return fmt.Errorf("invalid environment entry %q", key)
		}
	}

	if err := validatePaths("readableRoots", r.ReadableRoots); err != nil {
		return err
	}
	if err := validatePaths("writableRoots", r.WritableRoots); err != nil {
		return err
	}
	if err := validatePaths("readOnlyRoots", r.ReadOnlyRoots); err != nil {
		return err
	}
	if err := validatePaths("deniedRoots", r.DeniedRoots); err != nil {
		return err
	}
	if err := validatePaths("allowUnixSockets", r.AllowUnixSockets); err != nil {
		return err
	}
	if !coveredByAny(r.Cwd, r.ReadableRoots) {
		return errors.New("cwd is outside readable authority")
	}
	for _, root := range r.WritableRoots {
		if !coveredByAny(root, r.ReadableRoots) {
			return fmt.Errorf("writable root %q is outside readable authority", root)
		}
	}
	for _, root := range r.ReadOnlyRoots {
		if !coveredByAny(root, r.ReadableRoots) {
			return fmt.Errorf("read-only root %q is outside readable authority", root)
		}
		for _, writable := range r.WritableRoots {
			if samePath(root, writable) {
				return fmt.Errorf("path %q cannot be both writable and read-only", root)
			}
		}
	}
	for _, denied := range r.DeniedRoots {
		for _, writable := range r.WritableRoots {
			if samePath(denied, writable) {
				return fmt.Errorf("path %q cannot be both writable and denied", denied)
			}
		}
	}
	return nil
}

func validatePaths(label string, paths []string) error {
	if len(paths) > MaxRoots {
		return fmt.Errorf("%s exceeds %d entries", label, MaxRoots)
	}
	seen := make(map[string]struct{}, len(paths))
	for index, candidate := range paths {
		if err := validateAbsolutePath(fmt.Sprintf("%s[%d]", label, index), candidate); err != nil {
			return err
		}
		clean := filepath.Clean(candidate)
		key := clean
		if filepath.Separator == '\\' {
			key = strings.ToLower(key)
		}
		if _, exists := seen[key]; exists {
			return fmt.Errorf("%s contains duplicate path %q", label, candidate)
		}
		seen[key] = struct{}{}
	}
	return nil
}

func validateAbsolutePath(label, candidate string) error {
	if candidate == "" || strings.IndexByte(candidate, 0) >= 0 {
		return fmt.Errorf("%s must be a non-empty absolute path", label)
	}
	if !filepath.IsAbs(candidate) {
		return fmt.Errorf("%s must be an absolute native path: %q", label, candidate)
	}
	if volume := filepath.VolumeName(candidate); filepath.Separator == '\\' && volume == "" {
		return fmt.Errorf("%s must include a Windows volume: %q", label, candidate)
	}
	return nil
}

func coveredByAny(candidate string, roots []string) bool {
	for _, root := range roots {
		if containsPath(root, candidate) {
			return true
		}
	}
	return false
}

func samePath(left, right string) bool {
	left = filepath.Clean(left)
	right = filepath.Clean(right)
	if filepath.Separator == '\\' {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func containsPath(root, candidate string) bool {
	root = filepath.Clean(root)
	candidate = filepath.Clean(candidate)
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}
