//go:build windows

package windowsnative

import (
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
