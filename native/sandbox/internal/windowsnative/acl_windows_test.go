//go:build windows

package windowsnative

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

func TestNamedACLAcceptsUnmappedCapabilitySID(t *testing.T) {
	capabilitySID, err := windowsmodel.RandomCapabilitySID()
	if err != nil {
		t.Fatal(err)
	}
	target := t.TempDir()
	if err := replaceNamedACLEntries(
		target,
		[]string{capabilitySID},
		[]namedACLEntry{{
			SID:         capabilitySID,
			Permissions: fileReadExecuteMask,
			AccessMode:  grantAccess,
		}},
	); err != nil {
		t.Fatalf("grant arbitrary capability SID: %v", err)
	}
	if err := replaceNamedACLEntries(target, []string{capabilitySID}, nil); err != nil {
		t.Fatalf("revoke arbitrary capability SID: %v", err)
	}
}

func TestMaterializeProtectedRootAcceptsShortPathAliasWithinWritableRoot(t *testing.T) {
	writable := t.TempDir()
	writablePath, err := syscall.UTF16PtrFromString(writable)
	if err != nil {
		t.Fatal(err)
	}
	buffer := make([]uint16, 32768)
	length, err := syscall.GetLongPathName(writablePath, &buffer[0], uint32(len(buffer)))
	if err != nil {
		t.Fatal(err)
	}
	if length == 0 || int(length) >= len(buffer) {
		t.Skip("Windows long path form is unavailable")
	}
	longWritable := syscall.UTF16ToString(buffer[:length])
	longPath, err := syscall.UTF16PtrFromString(longWritable)
	if err != nil {
		t.Fatal(err)
	}
	length, err = syscall.GetShortPathName(longPath, &buffer[0], uint32(len(buffer)))
	if err != nil {
		t.Fatal(err)
	}
	if length == 0 || int(length) >= len(buffer) {
		t.Skip("Windows short path alias is unavailable")
	}
	shortWritable := syscall.UTF16ToString(buffer[:length])
	if strings.EqualFold(shortWritable, longWritable) {
		t.Skip("test volume did not provide a distinct 8.3 path alias")
	}

	protected := filepath.Join(shortWritable, ".nexus")
	if err := materializeProtectedRoot(protected, []string{longWritable}); err != nil {
		t.Fatalf("materialize protected root through 8.3 alias: %v", err)
	}
	info, err := os.Stat(filepath.Join(longWritable, ".nexus"))
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() {
		t.Fatal("protected root was not materialized as a directory")
	}
}
