//go:build windows

package windowsnative

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

type authorityPlan struct {
	RestrictingSIDs []string
	OfflineSID      string
	OnlineSID       string
	GroupSID        string
}

const currentACLStateRevision = 1

type aclApplicationState struct {
	Revision int               `json:"revision"`
	GroupSID string            `json:"groupSid"`
	Roots    map[string]string `json:"roots"`
	ReadOnly map[string]string `json:"readOnly"`
	Denied   map[string]string `json:"denied"`
}

func prepareAuthority(request protocol.Request) (authorityPlan, error) {
	var result authorityPlan
	err := withAuthorityLock(func() error {
		var err error
		result, err = prepareAuthorityLocked(request)
		return err
	})
	return result, err
}

func prepareAuthorityLocked(request protocol.Request) (authorityPlan, error) {
	marker, err := loadSetupMarker()
	if err != nil {
		return authorityPlan{}, err
	}
	registry, err := loadCapabilityRegistry()
	if err != nil {
		return authorityPlan{}, err
	}
	readable, err := canonicalExistingRoots(request.ReadableRoots, false)
	if err != nil {
		return authorityPlan{}, err
	}
	writable, err := canonicalExistingRoots(request.WritableRoots, true)
	if err != nil {
		return authorityPlan{}, err
	}
	ambient, err := canonicalExistingRoots(platformDefaultReadRoots(), false)
	if err != nil {
		return authorityPlan{}, err
	}
	ephemeral := ephemeralRootSet(request)
	capabilityReadable := make([]string, 0, len(readable))
	for _, root := range readable {
		if pathWithinAny(root, ambient) && !containsCanonical(writable, root) {
			continue
		}
		if _, temporary := ephemeral[root]; temporary {
			continue
		}
		capabilityReadable = append(capabilityReadable, root)
	}
	persistentWritable := make([]string, 0, len(writable))
	for _, root := range writable {
		if _, temporary := ephemeral[root]; !temporary {
			persistentWritable = append(persistentWritable, root)
		}
	}
	plan, changed, err := registry.BuildPlan(
		capabilityReadable,
		persistentWritable,
		nil,
	)
	if err != nil {
		return authorityPlan{}, err
	}
	for _, root := range readable {
		if _, temporary := ephemeral[root]; !temporary {
			continue
		}
		readSID, err := windowsmodel.RandomCapabilitySID()
		if err != nil {
			return authorityPlan{}, err
		}
		caps := windowsmodel.RootCapabilities{ReadSID: readSID}
		plan.RestrictingSIDs = append(plan.RestrictingSIDs, readSID)
		if containsCanonical(writable, root) {
			writeSID, err := windowsmodel.RandomCapabilitySID()
			if err != nil {
				return authorityPlan{}, err
			}
			caps.WriteSID = writeSID
			plan.RestrictingSIDs = append(plan.RestrictingSIDs, writeSID)
		}
		plan.Roots[root] = caps
	}
	if changed {
		data, err := json.Marshal(registry)
		if err != nil {
			return authorityPlan{}, err
		}
		if err := writeFileAtomic(capabilityPath(), data, 0o600); err != nil {
			return authorityPlan{}, fmt.Errorf("persist Windows capability registry: %w", err)
		}
	}
	if err := applyAuthorityACLs(
		request,
		plan,
		marker.OfflineSID,
		marker.OnlineSID,
		marker.GroupSID,
	); err != nil {
		return authorityPlan{}, err
	}
	return authorityPlan{
		RestrictingSIDs: plan.RestrictingSIDs,
		OfflineSID:      marker.OfflineSID,
		OnlineSID:       marker.OnlineSID,
		GroupSID:        marker.GroupSID,
	}, nil
}

func ephemeralRootSet(request protocol.Request) map[string]struct{} {
	result := make(map[string]struct{})
	for _, key := range []string{"TEMP", "TMP", "TMPDIR"} {
		value := environmentValue(request.Environment, key)
		if value == "" {
			continue
		}
		resolved, err := filepath.EvalSymlinks(value)
		if err != nil {
			continue
		}
		canonical, err := windowsmodel.CanonicalWindowsPath(resolved)
		if err == nil {
			result[canonical] = struct{}{}
		}
	}
	return result
}

func environmentValue(environment map[string]string, key string) string {
	for candidate, value := range environment {
		if strings.EqualFold(candidate, key) {
			return value
		}
	}
	return ""
}

func loadSetupMarker() (windowsmodel.SetupMarker, error) {
	data, err := os.ReadFile(markerPath())
	if err != nil {
		return windowsmodel.SetupMarker{}, err
	}
	var marker windowsmodel.SetupMarker
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&marker); err != nil {
		return windowsmodel.SetupMarker{}, err
	}
	if windowsmodel.EvaluateSetupMarker(data).State != windowsmodel.SetupReady {
		return windowsmodel.SetupMarker{}, errors.New("Windows sandbox setup marker is not ready")
	}
	return marker, nil
}

func loadCapabilityRegistry() (windowsmodel.CapabilityRegistry, error) {
	data, err := os.ReadFile(capabilityPath())
	if errors.Is(err, os.ErrNotExist) {
		return windowsmodel.CapabilityRegistry{
			Roots: make(map[string]windowsmodel.RootCapabilities),
		}, nil
	}
	if err != nil {
		return windowsmodel.CapabilityRegistry{}, err
	}
	var registry windowsmodel.CapabilityRegistry
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&registry); err != nil {
		return windowsmodel.CapabilityRegistry{}, fmt.Errorf("decode capability registry: %w", err)
	}
	if err := requireJSONEOF(decoder, "capability registry"); err != nil {
		return windowsmodel.CapabilityRegistry{}, err
	}
	if registry.Roots == nil {
		registry.Roots = make(map[string]windowsmodel.RootCapabilities)
	}
	if err := validateCapabilityRegistry(registry); err != nil {
		return windowsmodel.CapabilityRegistry{}, err
	}
	return registry, nil
}

func validateCapabilityRegistry(registry windowsmodel.CapabilityRegistry) error {
	if len(registry.Roots) > 8192 {
		return errors.New("Windows capability registry exceeds 8192 roots")
	}
	seen := make(map[string]string, len(registry.Roots)*2)
	for root, caps := range registry.Roots {
		canonical, err := windowsmodel.CanonicalWindowsPath(root)
		if err != nil || canonical != root {
			return fmt.Errorf("capability registry contains non-canonical root %q", root)
		}
		if caps.ReadSID == "" {
			return fmt.Errorf("capability registry root %q has no read SID", root)
		}
		for kind, value := range map[string]string{
			"read":  caps.ReadSID,
			"write": caps.WriteSID,
		} {
			if value == "" {
				continue
			}
			if _, err := syscall.StringToSid(value); err != nil {
				return fmt.Errorf(
					"capability registry root %q has invalid %s SID: %w",
					root,
					kind,
					err,
				)
			}
			key := strings.ToLower(value)
			if owner, exists := seen[key]; exists {
				return fmt.Errorf(
					"capability SID %s is reused by %q and %q",
					value,
					owner,
					root,
				)
			}
			seen[key] = root
		}
	}
	return nil
}

func canonicalExistingRoots(roots []string, required bool) ([]string, error) {
	result := make([]string, 0, len(roots))
	for _, root := range roots {
		resolved, err := filepath.EvalSymlinks(root)
		if err != nil {
			if !required && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("resolve sandbox root %q: %w", root, err)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			if !required && errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, fmt.Errorf("inspect sandbox root %q: %w", root, err)
		}
		if !info.IsDir() {
			return nil, fmt.Errorf("sandbox root is not a directory: %q", root)
		}
		canonical, err := windowsmodel.CanonicalWindowsPath(resolved)
		if err != nil {
			return nil, err
		}
		result = append(result, canonical)
	}
	return result, nil
}

func applyAuthorityACLs(
	request protocol.Request,
	plan windowsmodel.CapabilityPlan,
	offlineSID string,
	onlineSID string,
	groupSID string,
) error {
	icacls, err := systemExecutable("icacls.exe")
	if err != nil {
		return err
	}
	ambient, err := canonicalExistingRoots(platformDefaultReadRoots(), false)
	if err != nil {
		return err
	}
	state := loadACLApplicationState(groupSID)
	stateChanged := state.GroupSID != groupSID ||
		state.Revision != currentACLStateRevision
	if stateChanged {
		state = newACLApplicationState(groupSID)
	}
	ephemeral := ephemeralRootSet(request)
	readable := append([]string(nil), request.ReadableRoots...)
	sort.Strings(readable)
	for _, root := range readable {
		target, err := filepath.EvalSymlinks(root)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return err
		}
		key, err := windowsmodel.CanonicalWindowsPath(target)
		if err != nil {
			return err
		}
		caps, exists := plan.Roots[key]
		if !exists {
			if pathWithinAny(key, ambient) {
				continue
			}
			return fmt.Errorf("no capability plan for readable root %q", root)
		}
		writable := containsCanonicalRoot(request.WritableRoots, key)
		identityRights := "(OI)(CI)(RX)"
		if writable {
			identityRights = "(OI)(CI)(M)"
		}
		rootFingerprint := strings.Join(
			[]string{
				groupSID,
				caps.ReadSID,
				caps.WriteSID,
				identityRights,
			},
			"|",
		)
		_, isEphemeral := ephemeral[key]
		if !isEphemeral && state.Roots[key] == rootFingerprint {
			continue
		}
		sids := uniqueStrings(append(
			[]string{groupSID},
			plan.RestrictingSIDs...,
		))
		removeDenyArgs := []string{target, "/remove:d"}
		for _, sid := range sids {
			removeDenyArgs = append(removeDenyArgs, "*"+sid)
		}
		if err := runICACLS(icacls, removeDenyArgs...); err != nil {
			return fmt.Errorf("clear stale Nexus deny ACE on %q: %w", root, err)
		}
		grantArgs := []string{
			target,
			"/grant:r",
			"*" + groupSID + ":" + identityRights,
			"*" + caps.ReadSID + ":(OI)(CI)(RX)",
		}
		if writable {
			grantArgs = append(grantArgs, "*"+caps.WriteSID+":(OI)(CI)(M)")
		}
		if err := runICACLS(icacls, grantArgs...); err != nil {
			return err
		}
		if !isEphemeral {
			state.Roots[key] = rootFingerprint
			stateChanged = true
		}
	}

	for _, root := range request.ReadOnlyRoots {
		if err := materializeProtectedRoot(root, request.WritableRoots); err != nil {
			return err
		}
		target, err := filepath.EvalSymlinks(root)
		if err != nil {
			return err
		}
		sids := uniqueStrings(append(
			[]string{groupSID},
			writeCapabilitiesContaining(plan, root)...,
		))
		sortedSIDs := append([]string(nil), sids...)
		sort.Strings(sortedSIDs)
		protectedKey, err := windowsmodel.CanonicalWindowsPath(target)
		if err != nil {
			return err
		}
		fingerprint := strings.Join(sortedSIDs, "|")
		if state.ReadOnly[protectedKey] == fingerprint {
			continue
		}
		removeDenyArgs := []string{target, "/remove:d"}
		denyArgs := []string{target, "/deny"}
		for _, sid := range sids {
			removeDenyArgs = append(removeDenyArgs, "*"+sid)
			denyArgs = append(
				denyArgs,
				"*"+sid+":(OI)(CI)(WD,AD,WEA,WA,DC,DE)",
			)
		}
		if err := runICACLS(icacls, removeDenyArgs...); err != nil {
			return err
		}
		if err := runICACLS(icacls, denyArgs...); err != nil {
			return fmt.Errorf("enforce read-only root %q: %w", root, err)
		}
		state.ReadOnly[protectedKey] = fingerprint
		stateChanged = true
	}
	for _, root := range request.DeniedRoots {
		if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		target, err := filepath.EvalSymlinks(root)
		if err != nil {
			return err
		}
		sids := append([]string{groupSID}, plan.RestrictingSIDs...)
		sids = uniqueStrings(sids)
		sortedSIDs := append([]string(nil), sids...)
		sort.Strings(sortedSIDs)
		deniedKey, err := windowsmodel.CanonicalWindowsPath(target)
		if err != nil {
			return err
		}
		fingerprint := strings.Join(sortedSIDs, "|")
		if state.Denied[deniedKey] == fingerprint {
			continue
		}
		removeDenyArgs := []string{target, "/remove:d"}
		denyArgs := []string{target, "/deny"}
		for _, sid := range sids {
			removeDenyArgs = append(removeDenyArgs, "*"+sid)
			denyArgs = append(denyArgs, "*"+sid+":(OI)(CI)(F)")
		}
		if err := runICACLS(icacls, removeDenyArgs...); err != nil {
			return err
		}
		if err := runICACLS(icacls, denyArgs...); err != nil {
			return fmt.Errorf("enforce denied root %q: %w", root, err)
		}
		state.Denied[deniedKey] = fingerprint
		stateChanged = true
	}
	if stateChanged {
		data, err := json.Marshal(state)
		if err != nil {
			return err
		}
		if err := writeFileAtomic(aclStatePath(), data, 0o600); err != nil {
			return fmt.Errorf("persist Windows ACL application state: %w", err)
		}
	}
	return nil
}

func newACLApplicationState(groupSID string) aclApplicationState {
	return aclApplicationState{
		Revision: currentACLStateRevision,
		GroupSID: groupSID,
		Roots:    make(map[string]string),
		ReadOnly: make(map[string]string),
		Denied:   make(map[string]string),
	}
}

func loadACLApplicationState(groupSID string) aclApplicationState {
	data, err := os.ReadFile(aclStatePath())
	if err != nil {
		return newACLApplicationState(groupSID)
	}
	var state aclApplicationState
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil ||
		requireJSONEOF(decoder, "ACL application state") != nil ||
		state.Revision != currentACLStateRevision ||
		!strings.EqualFold(state.GroupSID, groupSID) ||
		state.Roots == nil ||
		state.ReadOnly == nil ||
		state.Denied == nil ||
		len(state.Roots) > 8192 ||
		len(state.ReadOnly) > 8192 ||
		len(state.Denied) > 8192 {
		return newACLApplicationState(groupSID)
	}
	return state
}

func requireJSONEOF(decoder *json.Decoder, label string) error {
	var trailing json.RawMessage
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return fmt.Errorf("Windows %s contains trailing JSON", label)
	}
	return fmt.Errorf("Windows %s has malformed trailing data: %w", label, err)
}

func platformDefaultReadRoots() []string {
	systemRoot := os.Getenv("SystemRoot")
	if systemRoot == "" {
		systemRoot = `C:\Windows`
	}
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	programFilesX86 := os.Getenv("ProgramFiles(x86)")
	if programFilesX86 == "" {
		programFilesX86 = `C:\Program Files (x86)`
	}
	programData := os.Getenv("ProgramData")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return []string{systemRoot, programFiles, programFilesX86, programData}
}

func pathWithinAny(candidate string, roots []string) bool {
	for _, root := range roots {
		contains, err := windowsmodel.WindowsPathContains(root, candidate)
		if err == nil && contains {
			return true
		}
	}
	return false
}

func containsCanonical(roots []string, candidate string) bool {
	for _, root := range roots {
		if strings.EqualFold(root, candidate) {
			return true
		}
	}
	return false
}

func materializeProtectedRoot(root string, writableRoots []string) error {
	if _, err := os.Stat(root); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("inspect protected root %q: %w", root, err)
	}
	canonical, err := windowsmodel.CanonicalWindowsPath(root)
	if err != nil {
		return err
	}
	for _, writable := range writableRoots {
		writableCanonical, err := canonicalResolvedRoot(writable)
		if err != nil {
			continue
		}
		contains, err := windowsmodel.WindowsPathContains(writableCanonical, canonical)
		if err == nil && contains {
			if err := os.MkdirAll(root, 0o700); err != nil {
				return fmt.Errorf("materialize protected root %q: %w", root, err)
			}
			return nil
		}
	}
	return fmt.Errorf("protected root does not exist outside writable authority: %q", root)
}

func canonicalResolvedRoot(root string) (string, error) {
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	return windowsmodel.CanonicalWindowsPath(resolved)
}

func containsCanonicalRoot(roots []string, key string) bool {
	for _, root := range roots {
		canonical, err := canonicalResolvedRoot(root)
		if err == nil && canonical == key {
			return true
		}
	}
	return false
}

func writeCapabilitiesContaining(plan windowsmodel.CapabilityPlan, candidate string) []string {
	key, err := canonicalResolvedRoot(candidate)
	if err != nil {
		return nil
	}
	var result []string
	for root, caps := range plan.Roots {
		if caps.WriteSID != "" && windowsPathContains(root, key) {
			result = append(result, caps.WriteSID)
		}
	}
	return result
}

func windowsPathContains(root, candidate string) bool {
	contains, err := windowsmodel.WindowsPathContains(root, candidate)
	return err == nil && contains
}

func runICACLS(executable string, args ...string) error {
	output, err := exec.Command(executable, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("icacls %q failed: %w: %s", args, err, strings.TrimSpace(string(output)))
	}
	return nil
}

func systemExecutable(name string) (string, error) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	candidate := filepath.Join(root, "System32", name)
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("trusted Windows executable is unavailable: %s", candidate)
	}
	return candidate, nil
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
