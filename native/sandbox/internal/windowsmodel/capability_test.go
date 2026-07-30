package windowsmodel

import (
	"strconv"
	"strings"
	"testing"
)

func TestCanonicalWindowsPathIsCaseInsensitiveAndSeparatorStable(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: `C:\Work\Nexus\.`, want: `c:\work\nexus`},
		{input: `c:/work/NEXUS`, want: `c:\work\nexus`},
		{input: `C:\Work\Nexus\..\Test`, want: `c:\work\test`},
		{input: `\\Server\Share\Folder\`, want: `\\server\share\folder`},
	}
	for _, test := range tests {
		got, err := CanonicalWindowsPath(test.input)
		if err != nil {
			t.Fatalf("%q: %v", test.input, err)
		}
		if got != test.want {
			t.Fatalf("%q => %q, want %q", test.input, got, test.want)
		}
	}
}

func TestCanonicalWindowsPathRejectsRelativeAndTraversalAboveRoot(t *testing.T) {
	for _, input := range []string{`work\nexus`, `C:relative`, `C:\..\Windows`, `\\server`} {
		if _, err := CanonicalWindowsPath(input); err == nil {
			t.Fatalf("accepted unsafe path %q", input)
		}
	}
}

func TestWindowsPathContainsUsesCanonicalComponentBoundaries(t *testing.T) {
	tests := []struct {
		root      string
		candidate string
		want      bool
	}{
		{root: `C:\Windows`, candidate: `c:\windows\System32`, want: true},
		{root: `C:\Windows`, candidate: `C:\Windows`, want: true},
		{root: `C:\Windows`, candidate: `C:\Windows.old`, want: false},
		{root: `\\Server\Share`, candidate: `\\server\share\tools`, want: true},
		{root: `C:\Program Files`, candidate: `D:\Program Files`, want: false},
	}
	for _, test := range tests {
		got, err := WindowsPathContains(test.root, test.candidate)
		if err != nil {
			t.Fatalf("%q / %q: %v", test.root, test.candidate, err)
		}
		if got != test.want {
			t.Fatalf(
				"WindowsPathContains(%q, %q) = %t, want %t",
				test.root,
				test.candidate,
				got,
				test.want,
			)
		}
	}
}

func TestBuildCapabilityPlanExcludesStaleWorkspaceAuthority(t *testing.T) {
	registry := CapabilityRegistry{
		Roots: map[string]RootCapabilities{
			`c:\old`: {
				ReadSID:  "S-1-5-21-10",
				WriteSID: "S-1-5-21-11",
			},
		},
	}
	plan, changed, err := registry.BuildPlan(
		[]string{`C:\Current`, `C:\SDK`},
		[]string{`c:\current`},
		func() (string, error) {
			return nextTestSID(), nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("new roots must persist capabilities")
	}
	for _, sid := range plan.RestrictingSIDs {
		if sid == "S-1-5-21-10" || sid == "S-1-5-21-11" {
			t.Fatalf("stale workspace SID entered active token: %#v", plan.RestrictingSIDs)
		}
	}
	if len(plan.Roots) != 2 || len(plan.RestrictingSIDs) != 3 {
		t.Fatalf("plan = %#v", plan)
	}
	current := plan.Roots[`c:\current`]
	if current.ReadSID == "" || current.WriteSID == "" {
		t.Fatalf("writable root lacks read/write capability: %#v", current)
	}
	sdk := plan.Roots[`c:\sdk`]
	if sdk.ReadSID == "" || sdk.WriteSID != "" {
		t.Fatalf("read-only root authority is wrong: %#v", sdk)
	}
}

func TestBuildCapabilityPlanReusesStableCapabilities(t *testing.T) {
	counter = 100
	registry := CapabilityRegistry{Roots: map[string]RootCapabilities{}}
	first, changed, err := registry.BuildPlan(
		[]string{`C:\Work`},
		[]string{`C:\Work`},
		func() (string, error) { return nextTestSID(), nil },
	)
	if err != nil || !changed {
		t.Fatalf("first plan: changed=%t err=%v", changed, err)
	}
	second, changed, err := registry.BuildPlan(
		[]string{`c:/WORK`},
		[]string{`c:\work`},
		func() (string, error) { return nextTestSID(), nil },
	)
	if err != nil || changed {
		t.Fatalf("second plan: changed=%t err=%v", changed, err)
	}
	if strings.Join(first.RestrictingSIDs, ",") != strings.Join(second.RestrictingSIDs, ",") {
		t.Fatalf("capabilities changed: %#v / %#v", first, second)
	}
}

func TestBuildCapabilityPlanDoesNotActivateHistoricalWriteAuthority(t *testing.T) {
	registry := CapabilityRegistry{
		Roots: map[string]RootCapabilities{
			`c:\work`: {
				ReadSID:  "S-1-5-21-1",
				WriteSID: "S-1-5-21-2",
			},
		},
	}
	plan, changed, err := registry.BuildPlan(
		[]string{`C:\Work`},
		nil,
		func() (string, error) {
			t.Fatal("stable read-only root must not generate a SID")
			return "", nil
		},
	)
	if err != nil || changed {
		t.Fatalf("plan changed=%t err=%v", changed, err)
	}
	if plan.Roots[`c:\work`].WriteSID != "" {
		t.Fatalf("historical write SID became active: %#v", plan)
	}
	if strings.Join(plan.RestrictingSIDs, ",") != "S-1-5-21-1" {
		t.Fatalf("restricting SIDs = %#v", plan.RestrictingSIDs)
	}
}

var counter uint32

func nextTestSID() string {
	counter++
	return "S-1-5-21-1-2-3-" + strconv.FormatUint(uint64(counter), 10)
}
