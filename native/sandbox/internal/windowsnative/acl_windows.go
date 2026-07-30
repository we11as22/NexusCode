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
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unsafe"

	"github.com/we11as22/NexusCode/native/sandbox/internal/protocol"
	"github.com/we11as22/NexusCode/native/sandbox/internal/windowsmodel"
)

type authorityPlan struct {
	RestrictingSIDs []string
	OfflineSID      string
	OnlineSID       string
	GroupSID        string
}

const currentACLStateRevision = 3

type aclApplicationState struct {
	Revision int               `json:"revision"`
	GroupSID string            `json:"groupSid"`
	Roots    map[string]string `json:"roots"`
	Traverse map[string]string `json:"traverse"`
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
	if changed, err := applyAncestorTraverseACLs(
		[]string{request.Cwd},
		plan,
		groupSID,
		&state,
	); err != nil {
		return err
	} else if changed {
		stateChanged = true
	}
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
		identityMask := uint32(fileReadExecuteMask)
		if writable {
			identityMask = fileModifyMask
		}
		entries := []namedACLEntry{
			{SID: groupSID, Permissions: identityMask, AccessMode: grantAccess},
			{SID: caps.ReadSID, Permissions: fileReadExecuteMask, AccessMode: grantAccess},
		}
		if writable {
			entries = append(entries, namedACLEntry{
				SID: caps.WriteSID, Permissions: fileModifyMask, AccessMode: grantAccess,
			})
		}
		if err := replaceNamedACLEntries(target, sids, entries); err != nil {
			return fmt.Errorf("apply Nexus capability ACL on %q: %w", root, err)
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
		entries := make([]namedACLEntry, 0, len(sids))
		for _, sid := range sids {
			entries = append(entries, namedACLEntry{
				SID: sid, Permissions: fileWriteDenyMask, AccessMode: denyAccess,
			})
		}
		if err := replaceNamedACLEntries(target, sids, entries); err != nil {
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
		entries := make([]namedACLEntry, 0, len(sids))
		for _, sid := range sids {
			entries = append(entries, namedACLEntry{
				SID: sid, Permissions: fileFullControlMask, AccessMode: denyAccess,
			})
		}
		if err := replaceNamedACLEntries(target, sids, entries); err != nil {
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

// applyAncestorTraverseACLs lets the private sandbox identities resolve a
// known readable root through profile directories that do not grant access to
// unrelated local accounts. PowerShell's filesystem provider requires
// directory-read while normalizing 8.3 aliases, so read/execute applies to each
// named ancestor itself but is deliberately non-inheritable: sibling trees and
// files do not gain authority. Capability ACLs on the selected root remain
// authoritative for writes.
func applyAncestorTraverseACLs(
	roots []string,
	plan windowsmodel.CapabilityPlan,
	groupSID string,
	state *aclApplicationState,
) (bool, error) {
	changed := false
	seen := make(map[string]struct{})
	for _, root := range roots {
		target, err := filepath.EvalSymlinks(root)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return false, fmt.Errorf("resolve readable root ancestors %q: %w", root, err)
		}
		stopAt := ""
		if profile := os.Getenv("USERPROFILE"); profile != "" {
			profileResolved, resolveErr := filepath.EvalSymlinks(profile)
			if resolveErr == nil {
				profileKey, keyErr := windowsmodel.CanonicalWindowsPath(profileResolved)
				targetKey, targetErr := windowsmodel.CanonicalWindowsPath(target)
				if keyErr == nil && targetErr == nil {
					contains, containsErr := windowsmodel.WindowsPathContains(
						profileKey,
						targetKey,
					)
					if containsErr == nil && contains {
						stopAt = profileKey
					}
				}
			}
		}
		for parent := filepath.Dir(target); ; parent = filepath.Dir(parent) {
			next := filepath.Dir(parent)
			if next == parent {
				break
			}
			key, err := windowsmodel.CanonicalWindowsPath(parent)
			if err != nil {
				return false, err
			}
			if _, duplicate := seen[key]; duplicate {
				continue
			}
			seen[key] = struct{}{}
			atStopBoundary := stopAt != "" && key == stopAt
			// Never downgrade a selected root that is also an ancestor of a
			// narrower readable root (for example workspace/.sandbox-temp).
			if _, selectedRoot := plan.Roots[key]; selectedRoot {
				if atStopBoundary {
					break
				}
				continue
			}
			fingerprint := groupSID + "|traverse-read-v2"
			if state.Traverse[key] == fingerprint {
				if atStopBoundary {
					break
				}
				continue
			}
			if err := replaceNamedACLEntries(
				parent,
				[]string{groupSID},
				[]namedACLEntry{{
					SID:         groupSID,
					Permissions: fileReadExecuteMask,
					AccessMode:  grantAccess,
					NoInherit:   true,
				}},
			); err != nil {
				return false, fmt.Errorf(
					"grant sandbox traverse authority on %q: %w",
					parent,
					err,
				)
			}
			state.Traverse[key] = fingerprint
			changed = true
			if atStopBoundary {
				break
			}
		}
	}
	return changed, nil
}

const (
	seFileObject            = 1
	daclSecurityInformation = 0x00000004

	denyAccess   = 3
	revokeAccess = 4

	subContainersAndObjectsInherit = 0x3

	fileGenericRead     = 0x00120089
	fileGenericWrite    = 0x00120116
	fileGenericExecute  = 0x001200A0
	fileDelete          = 0x00010000
	fileDeleteChild     = 0x00000040
	fileWriteData       = 0x00000002
	fileAppendData      = 0x00000004
	fileWriteEA         = 0x00000010
	fileWriteAttributes = 0x00000100

	fileReadExecuteMask = fileGenericRead | fileGenericExecute
	fileModifyMask      = fileGenericRead | fileGenericWrite | fileGenericExecute | fileDelete
	fileWriteDenyMask   = fileWriteData |
		fileAppendData |
		fileWriteEA |
		fileWriteAttributes |
		fileDeleteChild |
		fileDelete
	fileFullControlMask = 0x001F01FF
)

var (
	procGetNamedSecurityInfoW = advapi32.NewProc("GetNamedSecurityInfoW")
	procSetNamedSecurityInfoW = advapi32.NewProc("SetNamedSecurityInfoW")
)

type namedACLEntry struct {
	SID         string
	Permissions uint32
	AccessMode  uint32
	NoInherit   bool
}

// replaceNamedACLEntries performs a fail-closed two-phase DACL update. The
// first phase revokes explicit ACEs owned by NexusCode for the active trustees;
// the second adds the exact desired grants or denies. A crash between phases
// removes authority rather than retaining stale write access.
func replaceNamedACLEntries(
	target string,
	revokeSIDs []string,
	desired []namedACLEntry,
) error {
	revocations := make([]namedACLEntry, 0, len(revokeSIDs))
	for _, sid := range uniqueStrings(revokeSIDs) {
		revocations = append(revocations, namedACLEntry{
			SID: sid, AccessMode: revokeAccess,
		})
	}
	if err := applyNamedACLEntries(target, revocations); err != nil {
		return fmt.Errorf("revoke stale ACEs: %w", err)
	}
	if err := applyNamedACLEntries(target, desired); err != nil {
		return fmt.Errorf("install desired ACEs: %w", err)
	}
	return nil
}

func applyNamedACLEntries(target string, mutations []namedACLEntry) error {
	if len(mutations) == 0 {
		return nil
	}
	targetPointer, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	var oldACL *windowsACL
	var descriptor unsafe.Pointer
	status, _, _ := procGetNamedSecurityInfoW.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		seFileObject,
		daclSecurityInformation,
		0,
		0,
		uintptr(unsafe.Pointer(&oldACL)),
		0,
		uintptr(unsafe.Pointer(&descriptor)),
	)
	if status != errorSuccess {
		return fmt.Errorf("GetNamedSecurityInfoW failed with status %d", status)
	}
	if descriptor != nil {
		defer syscall.LocalFree(syscall.Handle(uintptr(descriptor)))
	}

	sids := make([]*syscall.SID, 0, len(mutations))
	entries := make([]explicitAccessW, 0, len(mutations))
	for _, mutation := range mutations {
		sid, err := syscall.StringToSid(mutation.SID)
		if err != nil {
			return fmt.Errorf("parse ACL SID %q: %w", mutation.SID, err)
		}
		sids = append(sids, sid)
		inheritance := uint32(0)
		if mutation.AccessMode != revokeAccess && !mutation.NoInherit {
			inheritance = subContainersAndObjectsInherit
		}
		entries = append(entries, explicitAccessW{
			Permissions: mutation.Permissions,
			AccessMode:  mutation.AccessMode,
			Inheritance: inheritance,
			Trustee: trusteeW{
				TrusteeForm: trusteeIsSID,
				TrusteeType: trusteeIsUnknown,
				Name:        (*uint16)(unsafe.Pointer(sid)),
			},
		})
	}
	var newACL *windowsACL
	status, _, _ = procSetEntriesInACLW.Call(
		uintptr(len(entries)),
		uintptr(unsafe.Pointer(&entries[0])),
		uintptr(unsafe.Pointer(oldACL)),
		uintptr(unsafe.Pointer(&newACL)),
	)
	runtime.KeepAlive(sids)
	if status != errorSuccess {
		return fmt.Errorf("SetEntriesInAclW failed with status %d", status)
	}
	if newACL != nil {
		defer syscall.LocalFree(syscall.Handle(uintptr(unsafe.Pointer(newACL))))
	}
	status, _, _ = procSetNamedSecurityInfoW.Call(
		uintptr(unsafe.Pointer(targetPointer)),
		seFileObject,
		daclSecurityInformation,
		0,
		0,
		uintptr(unsafe.Pointer(newACL)),
		0,
	)
	if status != errorSuccess {
		return fmt.Errorf("SetNamedSecurityInfoW failed with status %d", status)
	}
	return nil
}

func newACLApplicationState(groupSID string) aclApplicationState {
	return aclApplicationState{
		Revision: currentACLStateRevision,
		GroupSID: groupSID,
		Roots:    make(map[string]string),
		Traverse: make(map[string]string),
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
		state.Traverse == nil ||
		state.ReadOnly == nil ||
		state.Denied == nil ||
		len(state.Roots) > 8192 ||
		len(state.Traverse) > 32768 ||
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
	canonical, err := canonicalProspectivePath(root)
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

// canonicalProspectivePath resolves the deepest existing ancestor before
// appending missing path components. This matters on Windows because the same
// directory can arrive through an 8.3 alias (for example RUNNER~1) while
// EvalSymlinks returns its long name. Comparing the unresolved missing child
// against a resolved writable root would otherwise produce a false boundary
// denial.
func canonicalProspectivePath(candidate string) (string, error) {
	current := filepath.Clean(candidate)
	missing := make([]string, 0, 4)
	for {
		resolved, err := filepath.EvalSymlinks(current)
		if err == nil {
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return windowsmodel.CanonicalWindowsPath(resolved)
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("resolve prospective sandbox root %q: %w", candidate, err)
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", fmt.Errorf("resolve prospective sandbox root %q: %w", candidate, err)
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
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
