package protocol

import (
	"encoding/json"
	"path/filepath"
	"runtime"
	"testing"
)

func validRequest(t *testing.T) Request {
	t.Helper()
	root := t.TempDir()
	return Request{
		Version:       ProtocolVersion,
		ExecutionID:   "exec-123",
		Argv:          []string{"/bin/sh", "-lc", "echo ok"},
		Cwd:           root,
		ReadableRoots: []string{root},
		WritableRoots: []string{root},
		ReadOnlyRoots: []string{filepath.Join(root, ".git"), filepath.Join(root, ".nexus")},
		Network:       NetworkRestricted,
		TimeoutMillis: 120_000,
		InheritEnv:    true,
		Environment:   map[string]string{"NEXUS_TEST": "1"},
	}
}

func TestDecodeValidatesVersionAndShape(t *testing.T) {
	request := validRequest(t)
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}

	got, err := DecodeRequest(encoded)
	if err != nil {
		t.Fatalf("DecodeRequest() error = %v", err)
	}
	if got.Version != ProtocolVersion {
		t.Fatalf("version = %d, want %d", got.Version, ProtocolVersion)
	}
	if got.ExecutionID != request.ExecutionID {
		t.Fatalf("execution id = %q, want %q", got.ExecutionID, request.ExecutionID)
	}
}

func TestDecodeRejectsUnknownFieldsAndBypassFlags(t *testing.T) {
	request := validRequest(t)
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}

	var raw map[string]any
	if err := json.Unmarshal(encoded, &raw); err != nil {
		t.Fatal(err)
	}
	raw["disableSandbox"] = true
	encoded, err = json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := DecodeRequest(encoded); err == nil {
		t.Fatal("DecodeRequest() accepted an unknown bypass field")
	}
}

func TestDecodeRejectsTrailingJsonValues(t *testing.T) {
	request := validRequest(t)
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	encoded = append(encoded, []byte(` {"disableSandbox":true}`)...)
	if _, err := DecodeRequest(encoded); err == nil {
		t.Fatal("DecodeRequest() accepted a trailing JSON value")
	}
}

func TestValidateRejectsEmptyCommandRelativePathsAndInvalidNetwork(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Request)
	}{
		{"empty argv", func(r *Request) { r.Argv = nil }},
		{"relative cwd", func(r *Request) { r.Cwd = "relative" }},
		{"relative readable root", func(r *Request) { r.ReadableRoots = []string{"relative"} }},
		{"relative writable root", func(r *Request) { r.WritableRoots = []string{"relative"} }},
		{"relative protected root", func(r *Request) { r.ReadOnlyRoots = []string{"relative"} }},
		{"invalid network", func(r *Request) { r.Network = NetworkPolicy("sometimes") }},
		{"missing execution id", func(r *Request) { r.ExecutionID = "" }},
		{"invalid timeout", func(r *Request) { r.TimeoutMillis = -1 }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := validRequest(t)
			test.mutate(&request)
			if err := request.Validate(); err == nil {
				t.Fatal("Validate() unexpectedly succeeded")
			}
		})
	}
}

func TestValidateRejectsWritableRootOutsideReadableAuthority(t *testing.T) {
	request := validRequest(t)
	request.WritableRoots = []string{filepath.Join(t.TempDir(), "outside")}
	if err := request.Validate(); err == nil {
		t.Fatal("Validate() accepted writable root outside readable authority")
	}
}

func TestValidateRequiresPlatformNativeAbsolutePath(t *testing.T) {
	request := validRequest(t)
	if runtime.GOOS == "windows" {
		request.Cwd = `\rooted-but-no-volume`
	} else {
		request.Cwd = `C:\foreign\path`
	}
	if err := request.Validate(); err == nil {
		t.Fatal("Validate() accepted a foreign or volume-less path")
	}
}

func TestControlMessagesNeverShareCommandStreams(t *testing.T) {
	message := ControlMessage{
		Version:     ProtocolVersion,
		Type:        ControlStarted,
		ExecutionID: "exec-123",
		Sandbox:     "seatbelt",
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) == 0 || encoded[0] != '{' {
		t.Fatalf("control message is not JSON: %q", encoded)
	}
	if message.Stdout != "" || message.Stderr != "" {
		t.Fatal("control message unexpectedly carries command output")
	}
}
