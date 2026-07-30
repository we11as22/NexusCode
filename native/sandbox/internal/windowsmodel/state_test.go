package windowsmodel

import (
	"encoding/json"
	"testing"
)

func TestEvaluateSetupMarkerRejectsEveryIncompleteSecurityBoundary(t *testing.T) {
	valid := SetupMarker{
		SetupVersion:        CurrentSetupVersion,
		OfflineSID:          "S-1-5-21-1",
		OnlineSID:           "S-1-5-21-2",
		GroupSID:            "S-1-5-21-3",
		CredentialsRevision: CurrentCredentialsRevision,
		FirewallRevision:    CurrentFirewallRevision,
	}
	tests := []struct {
		name string
		data []byte
		want SetupState
	}{
		{name: "missing", data: nil, want: SetupMissing},
		{name: "corrupt", data: []byte("{"), want: SetupCorrupt},
		{name: "stale version", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.SetupVersion-- })), want: SetupStale},
		{name: "missing offline identity", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.OfflineSID = "" })), want: SetupCorrupt},
		{name: "same identity", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.OnlineSID = m.OfflineSID })), want: SetupCorrupt},
		{name: "missing sandbox group", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.GroupSID = "" })), want: SetupCorrupt},
		{name: "stale credentials", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.CredentialsRevision-- })), want: SetupStale},
		{name: "stale firewall", data: markerJSON(t, mutateMarker(valid, func(m *SetupMarker) { m.FirewallRevision-- })), want: SetupStale},
		{name: "ready", data: markerJSON(t, valid), want: SetupReady},
		{name: "trailing value", data: append(markerJSON(t, valid), []byte(` {}`)...), want: SetupCorrupt},
		{name: "trailing garbage", data: append(markerJSON(t, valid), []byte(` broken`)...), want: SetupCorrupt},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			status := EvaluateSetupMarker(test.data)
			if status.State != test.want {
				t.Fatalf("state = %q, want %q (detail=%q)", status.State, test.want, status.Detail)
			}
			if test.want != SetupReady && status.Detail == "" {
				t.Fatal("non-ready status must explain remediation")
			}
		})
	}
}

func TestSetupStatusJSONNeverContainsCredentials(t *testing.T) {
	status := SetupStatus{
		State:        SetupReady,
		SetupVersion: CurrentSetupVersion,
		OfflineSID:   "S-1-5-21-1",
		OnlineSID:    "S-1-5-21-2",
		GroupSID:     "S-1-5-21-3",
		Detail:       "ready",
	}
	data, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"password", "credential", "secret"} {
		if _, exists := decoded[forbidden]; exists {
			t.Fatalf("status leaked %q: %s", forbidden, data)
		}
	}
}

func markerJSON(t *testing.T, marker SetupMarker) []byte {
	t.Helper()
	data, err := json.Marshal(marker)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mutateMarker(marker SetupMarker, mutate func(*SetupMarker)) SetupMarker {
	mutate(&marker)
	return marker
}
