package windowsmodel

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const (
	CurrentSetupVersion        = 3
	CurrentCredentialsRevision = 1
	CurrentFirewallRevision    = 2
)

type SetupState string

const (
	SetupMissing SetupState = "not-installed"
	SetupStale   SetupState = "stale"
	SetupCorrupt SetupState = "broken"
	SetupReady   SetupState = "ready"
)

type SetupMarker struct {
	SetupVersion        int    `json:"setupVersion"`
	OfflineSID          string `json:"offlineSid"`
	OnlineSID           string `json:"onlineSid"`
	GroupSID            string `json:"groupSid"`
	CredentialsRevision int    `json:"credentialsRevision"`
	FirewallRevision    int    `json:"firewallRevision"`
}

type SetupStatus struct {
	State        SetupState `json:"state"`
	SetupVersion int        `json:"setupVersion"`
	OfflineSID   string     `json:"offlineSid,omitempty"`
	OnlineSID    string     `json:"onlineSid,omitempty"`
	GroupSID     string     `json:"groupSid,omitempty"`
	Detail       string     `json:"detail,omitempty"`
}

func EvaluateSetupMarker(data []byte) SetupStatus {
	if len(bytes.TrimSpace(data)) == 0 {
		return SetupStatus{
			State:  SetupMissing,
			Detail: "Windows sandbox setup has not been completed",
		}
	}
	var marker SetupMarker
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&marker); err != nil {
		return SetupStatus{
			State:  SetupCorrupt,
			Detail: fmt.Sprintf("Windows sandbox setup marker is invalid: %v", err),
		}
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return SetupStatus{State: SetupCorrupt, Detail: err.Error()}
	}
	status := SetupStatus{
		SetupVersion: marker.SetupVersion,
		OfflineSID:   marker.OfflineSID,
		OnlineSID:    marker.OnlineSID,
		GroupSID:     marker.GroupSID,
	}
	if marker.OfflineSID == "" ||
		marker.OnlineSID == "" ||
		marker.GroupSID == "" ||
		marker.OfflineSID == marker.OnlineSID {
		status.State = SetupCorrupt
		status.Detail = "Windows sandbox identities are missing or invalid"
		return status
	}
	if marker.SetupVersion != CurrentSetupVersion ||
		marker.CredentialsRevision != CurrentCredentialsRevision ||
		marker.FirewallRevision != CurrentFirewallRevision {
		status.State = SetupStale
		status.Detail = "Windows sandbox security setup is out of date"
		return status
	}
	status.State = SetupReady
	status.Detail = "Windows sandbox is ready"
	return status
}

func rejectTrailingJSON(decoder *json.Decoder) error {
	var trailing json.RawMessage
	err := decoder.Decode(&trailing)
	if err == nil {
		return errors.New("Windows sandbox setup marker contains trailing JSON")
	}
	if !errors.Is(err, io.EOF) {
		return fmt.Errorf("Windows sandbox setup marker has malformed trailing data: %w", err)
	}
	return nil
}
